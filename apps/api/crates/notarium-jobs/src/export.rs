use std::{
    fs::File,
    io::{self, Seek, SeekFrom, Write},
    time::Duration,
};

use bytes::Bytes;
use notarium_canonical::{
    JobCompletionOutcome, codec,
    peers::{
        archive_export::{
            ExportChatBody, ExportChatEntry, ExportChatHeader, ExportData, ExportEntry,
            ExportPublication,
        },
        archive_import::{ArchiveObject, ArchiveObjectKind},
    },
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{BackupId, ContentDigest},
    model::HistoryScope,
    ports::{CallBudget, Cancellation},
};
use serde::Serialize;
use tokio::sync::mpsc;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{ArchiveJobs, JobExecution, import::check_cancelled, worker::command_budget};

const MAX_EXPORT_BYTES: u64 = 32 * 1024 * 1024 * 1024;

struct ZipEntry {
    path: String,
    body: mpsc::Receiver<Bytes>,
}

struct ExportSource {
    hold: BackupId,
    scope: HistoryScope,
    generation: u64,
}

impl ArchiveJobs {
    pub(crate) async fn export(
        &self,
        job: &JobExecution,
    ) -> Result<JobCompletionOutcome, PortError> {
        let ctx = job.authorize().await?;
        let mut cut = self.store.capture_archive_export(&ctx, job.claim()).await?;
        let source = ExportSource {
            hold: cut.hold_id.clone(),
            scope: cut.scope.clone(),
            generation: cut.generation,
        };
        let entries = std::mem::take(&mut cut.entries);
        let files = entries.len() as u64;
        let monitor = async {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                self.store
                    .check_export_generation(
                        &command_budget(job.cancellation())?,
                        job.scope(),
                        source.generation,
                    )
                    .await?;
            }
        };
        let result = tokio::select! {
            object = self.write_export(job, &ctx.budget, &source, entries, files) => object,
            failed = monitor => failed,
        };
        let seq = cut.seq;
        let released = cut.release().await;
        let object = result?;
        released?;
        Ok(JobCompletionOutcome::Exported(ExportPublication {
            object,
            cut: seq,
            privacy_generation: source.generation,
            files,
        }))
    }

    async fn write_export(
        &self,
        job: &JobExecution,
        budget: &CallBudget,
        source: &ExportSource,
        entries: Vec<ExportEntry>,
        files: u64,
    ) -> Result<ArchiveObject, PortError> {
        let scratch = self.artifacts.scratch()?;
        let file = scratch.open_new("export.zip")?;
        let (commands, receiver) = mpsc::channel(1);
        let writer = job.blocking(move |cancel| write_zip(file, receiver, cancel));
        let producer = async {
            for (index, entry) in entries.into_iter().enumerate() {
                if index % 128 == 0 {
                    job.authorize().await?;
                }
                check_cancelled(job.cancellation())?;
                let (out, body) = mpsc::channel(2);
                commands
                    .send(ZipEntry {
                        path: entry.path,
                        body,
                    })
                    .await
                    .map_err(|_| cancelled())?;
                match entry.data {
                    ExportData::Blob(digest) => {
                        self.store
                            .stream_held_blob(budget, &source.hold, job.scope(), digest, &out)
                            .await?;
                    }
                    ExportData::Chat(chat) => {
                        export_chat_header(&chat.header, budget, &out).await?;
                        self.export_chat_entries(budget, source, chat.entries, &out)
                            .await?;
                    }
                    ExportData::PagedChat(header, chat) => {
                        export_chat_header(&header, budget, &out).await?;
                        let mut after = 0;
                        loop {
                            let page = chat.page(&self.store, budget, after).await?;
                            let Some(last) = page.last() else { break };
                            after = last.seq;
                            self.export_chat_entries(budget, source, page, &out).await?;
                        }
                    }
                }
                job.report_progress(index as u64 + 1, Some(files));
            }
            drop(commands);
            Ok::<_, PortError>(())
        };
        let (produced, written) = tokio::join!(producer, writer);
        written?;
        produced?;
        self.seal_attempt(
            job,
            &scratch,
            "export.zip",
            ArchiveObjectKind::Export,
            MAX_EXPORT_BYTES,
        )
        .await
    }

    async fn export_chat_entries(
        &self,
        budget: &CallBudget,
        source: &ExportSource,
        entries: Vec<ExportChatEntry>,
        output: &mpsc::Sender<Bytes>,
    ) -> Result<(), PortError> {
        #[derive(Serialize)]
        struct Entry<'a> {
            #[serde(rename = "type")]
            entry_type: &'static str,
            entry_seq: u64,
            parent_seq: Option<u64>,
            kind: &'a str,
            author: &'a str,
            seconds: i64,
            nanos: u32,
        }
        for entry in entries {
            let redacted = matches!(&entry.body, ExportChatBody::Redacted);
            let mut line = json(&Entry {
                entry_type: "entry",
                entry_seq: entry.seq,
                parent_seq: entry.parent,
                kind: if redacted { "redacted" } else { &entry.kind },
                author: entry.author.as_str(),
                seconds: entry.seconds,
                nanos: entry.nanos,
            })?;
            line.pop();
            line.extend(b",\"body\":");
            match entry.body {
                ExportChatBody::Inline(text) => line.extend(json(&text)?),
                ExportChatBody::Redacted => line.extend(b"null"),
                ExportChatBody::Blob(digest) => {
                    line.push(b'"');
                    send(output, Bytes::from(line), &budget.cancellation).await?;
                    self.export_chat_blob(budget, source, digest, output)
                        .await?;
                    line = vec![b'"'];
                }
            }
            line.extend(b"}\n");
            send(output, Bytes::from(line), &budget.cancellation).await?;
        }
        Ok(())
    }

    async fn export_chat_blob(
        &self,
        budget: &CallBudget,
        source: &ExportSource,
        digest: ContentDigest,
        output: &mpsc::Sender<Bytes>,
    ) -> Result<(), PortError> {
        let (raw, mut chunks) = mpsc::channel(2);
        let read = async {
            let result = self
                .store
                .stream_held_blob(budget, &source.hold, &source.scope, digest, &raw)
                .await;
            drop(raw);
            result
        };
        let encode = async move {
            let mut carry = Vec::with_capacity(4);
            while let Some(chunk) = chunks.recv().await {
                let mut input = Vec::with_capacity(carry.len() + chunk.len());
                input.extend_from_slice(&carry);
                input.extend_from_slice(&chunk);
                carry.clear();
                let text = match std::str::from_utf8(&input) {
                    Ok(text) => text,
                    Err(err) if err.error_len().is_none() => {
                        carry.extend_from_slice(&input[err.valid_up_to()..]);
                        std::str::from_utf8(&input[..err.valid_up_to()])
                            .map_err(|_| invalid_utf8())?
                    }
                    Err(_) => return Err(invalid_utf8()),
                };
                if !text.is_empty() {
                    let mut escaped = json(&text)?;
                    escaped.pop();
                    send(
                        output,
                        Bytes::from(escaped).slice(1..),
                        &budget.cancellation,
                    )
                    .await?;
                }
            }
            if !carry.is_empty() {
                return Err(invalid_utf8());
            }
            Ok(())
        };
        let (read, encoded) = tokio::join!(read, encode);
        read?;
        encoded
    }
}

async fn export_chat_header(
    header: &ExportChatHeader,
    budget: &CallBudget,
    output: &mpsc::Sender<Bytes>,
) -> Result<(), PortError> {
    let mut line = json(&serde_json::json!({
        "type": "thread", "version": 1, "header": header,
    }))?;
    line.push(b'\n');
    send(output, Bytes::from(line), &budget.cancellation).await
}

fn write_zip(
    file: File,
    mut commands: mpsc::Receiver<ZipEntry>,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    let mut zip = ZipWriter::new(LimitedFile::new(file, MAX_EXPORT_BYTES));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(true);
    while let Some(mut entry) = commands.blocking_recv() {
        check_cancelled(cancellation)?;
        zip.start_file(entry.path, options).map_err(zip_error)?;
        while let Some(data) = entry.body.blocking_recv() {
            check_cancelled(cancellation)?;
            zip.write_all(&data).map_err(zip_io)?;
        }
    }
    check_cancelled(cancellation)?;
    zip.finish()
        .map_err(zip_error)?
        .file
        .sync_all()
        .map_err(zip_io)
}

pub(crate) struct LimitedFile {
    pub(crate) file: File,
    max: u64,
    position: u64,
}

impl LimitedFile {
    pub(crate) fn new(file: File, max: u64) -> Self {
        Self {
            file,
            max,
            position: 0,
        }
    }
}

impl Write for LimitedFile {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let remaining = self.max.saturating_sub(self.position);
        if data.len() as u64 > remaining {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "archive size ceiling",
            ));
        }
        let written = self.file.write(data)?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Seek for LimitedFile {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let position = self.file.seek(pos)?;
        self.position = position;
        Ok(position)
    }
}

fn json(value: &impl Serialize) -> Result<Vec<u8>, PortError> {
    serde_json::to_vec(value)
        .map_err(|e| codec::internal_not_committed("export_chat_json", e.to_string()))
}

async fn send(
    output: &mpsc::Sender<Bytes>,
    data: Bytes,
    cancellation: &Cancellation,
) -> Result<(), PortError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(cancelled()),
        result = output.send(data) => result.map_err(|_| cancelled()),
    }
}

fn cancelled() -> PortError {
    codec::cancelled_not_committed("archive_export_cancelled", "archive export cancelled")
}

fn invalid_utf8() -> PortError {
    DomainError::validation(ValidationReason::InvalidUtf8).into()
}

pub(crate) fn zip_error(error: zip::result::ZipError) -> PortError {
    match error {
        zip::result::ZipError::Io(err) => zip_io(err),
        _ => codec::internal_not_committed("archive_zip_write", error.to_string()),
    }
}

pub(crate) fn zip_io(error: io::Error) -> PortError {
    if error.kind() == io::ErrorKind::FileTooLarge {
        return DomainError::validation(ValidationReason::BudgetExceeded).into();
    }
    codec::internal_not_committed("archive_zip_io", error.kind().to_string())
}
