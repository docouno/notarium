#[path = "../examples/d3_benchmarks/writer_samples.rs"]
mod writer_samples;

use writer_samples::WriterEditSamples;

#[test]
fn admitted_edits_keep_drain_latency_and_only_in_window_receipts_count_for_throughput() {
    let mut samples = WriterEditSamples::new(0);
    for (start, finish, elapsed_ns, digest) in [
        (0, 1, 90, Some([0; 32])),
        (0, 1, 91, None),
        (1, 1, 10, Some([1; 32])),
        (1, 1, 20, None),
        (1, 2, 3_000, Some([2; 32])),
        (1, 2, 5_000, None),
        (2, 2, 92, Some([3; 32])),
        (2, 2, 93, None),
    ] {
        samples.record(start, finish, elapsed_ns, digest);
    }
    assert_eq!(samples.completed_digests, [[1; 32]]);
    assert_eq!(samples.successful_ns, [10, 3_000]);
    assert_eq!(samples.failed_ns, [20, 5_000]);
}
