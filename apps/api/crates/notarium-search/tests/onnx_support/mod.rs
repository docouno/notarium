use notarium_core::ids::ModelProfileId;
use std::{
    fs,
    path::{Path, PathBuf},
};

// ONNX IR 10, opset 13. OneHot(input_ids, 64, [0, 1]) followed by
// Identity gives distinct basis vectors so padding and pooling are observable.
const EMBEDDING_MODEL: &str = concat!(
    "080a3a9d020a2c0a09696e7075745f6964730a0564657074680a0676616c756573120865",
    "7870616e64656422064f6e65486f740a270a08657870616e64656412116c6173745f6869",
    "6464656e5f737461746522084964656e746974791211656d62656464696e675f66697874",
    "7572652a131007420564657074684a0840000000000000002a1608021001420676616c75",
    "65734a08000000000000803f5a250a09696e7075745f69647312180a16080712120a0612",
    "04726f77730a081206746f6b656e735a2a0a0e617474656e74696f6e5f6d61736b12180a",
    "16080712120a061204726f77730a081206746f6b656e7362310a116c6173745f68696464",
    "656e5f7374617465121c0a1a080112160a061204726f77730a081206746f6b656e730a02",
    "08404202100d",
);

// The second graph repeatedly updates a live token tensor in an ONNX Loop.
// Modulo 64 restores the input tokens after the slow loop.
const INTERRUPTIBLE_MODEL: &str = concat!(
    "080a3adb040a93020a0574726970730a0772756e6e696e670a09696e7075745f696473",
    "120b616363756d756c6174656422044c6f6f702ae2010a04626f647932d6010a1d0a07",
    "636f6e645f696e1208636f6e645f6f757422084964656e746974790a190a036163630a",
    "036f6e6512086e6578745f616363220341646412096c6f6f705f626f64792a11100742",
    "036f6e654a0801000000000000005a0e0a046974657212060a04080712005a110a0763",
    "6f6e645f696e12060a04080912005a1f0a0361636312180a16080712120a061204726f",
    "77730a081206746f6b656e7362120a08636f6e645f6f757412060a040809120062240a",
    "086e6578745f61636312180a16080712120a061204726f77730a081206746f6b656e73",
    "a001050a200a0b616363756d756c617465640a05646570746812056d6f64363422034d",
    "6f640a310a056d6f6436340a0564657074680a0676616c75657312116c6173745f6869",
    "6464656e5f737461746522064f6e65486f741216656d62656464696e675f6c6f6f705f",
    "666978747572652a131007420574726970734a08404b4c00000000002a0e1009420772",
    "756e6e696e674a01012a131007420564657074684a0840000000000000002a16080210",
    "01420676616c7565734a08000000000000803f5a250a09696e7075745f69647312180a",
    "16080712120a061204726f77730a081206746f6b656e735a2a0a0e617474656e74696f",
    "6e5f6d61736b12180a16080712120a061204726f77730a081206746f6b656e7362310a",
    "116c6173745f68696464656e5f7374617465121c0a1a080112160a061204726f77730a",
    "081206746f6b656e730a0208404202100d",
);

pub fn library() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/onnxruntime/current/libonnxruntime.so")
        .canonicalize()
        .expect("run make setup to prepare the pinned ONNX Runtime fixture")
}

pub struct ModelFiles(pub PathBuf);

impl ModelFiles {
    pub fn new() -> Self {
        let mut entropy = [0; 16];
        getrandom::fill(&mut entropy).unwrap();
        Self(std::env::temp_dir().join(format!("notarium-onnx-{}", hex::encode(entropy))))
    }

    pub fn install(&self, model: &ModelProfileId, slow: bool) {
        let profile = self.0.join(model.as_str());
        fs::create_dir_all(&profile).unwrap();
        let graph = if slow {
            INTERRUPTIBLE_MODEL
        } else {
            EMBEDDING_MODEL
        };
        fs::write(profile.join("model.onnx"), hex::decode(graph).unwrap()).unwrap();
        fs::write(
            profile.join("tokenizer.json"),
            r###"{
            "pre_tokenizer":{"type":"WhitespaceSplit"},
            "model":{"type":"WordPiece","vocab":{"[UNK]":0,"red":1,"blue":2,"[PAD]":3,"##dish":4},
            "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
        }"###,
        )
        .unwrap();
    }
}

impl Drop for ModelFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
