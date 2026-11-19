use notarium_core::{
    classes::AbilityKind,
    ids::*,
    model::Lifecycle,
    ports::control::{AbilityDescriptor, AbilityPlacement, AbilityRef},
};

pub(super) struct Builtin {
    pub name: &'static str,
    pub kind: AbilityKind,
    pub instructions: &'static str,
    skills: &'static [Builtin],
}

const RESEARCH_EVIDENCE: Builtin = Builtin {
    name: "research-evidence",
    kind: AbilityKind::Skill,
    instructions: "Attach a source to each material claim. Record what the source actually establishes and state uncertainty when evidence is missing or conflicting.",
    skills: &[],
};

const GROOMING_EVIDENCE: Builtin = Builtin {
    name: "grooming-evidence",
    kind: AbilityKind::Skill,
    instructions: "For each candidate, preserve its source and identify the affected user, observable problem, and acceptance evidence. Surface duplicates and dependencies.",
    skills: &[],
};

pub(super) static BUILTINS: [Builtin; 4] = [
    Builtin {
        name: "research",
        kind: AbilityKind::Role,
        instructions: "Turn the request into a bounded research question. Gather evidence through the available tools, check competing explanations, and report findings with sources and unresolved questions.",
        skills: &[RESEARCH_EVIDENCE],
    },
    RESEARCH_EVIDENCE,
    Builtin {
        name: "grooming",
        kind: AbilityKind::Role,
        instructions: "Review the requested backlog items against the current workspace. Prepare small, testable task drafts with dependencies and explicit exclusions. Ask for confirmation before changing the backlog.",
        skills: &[GROOMING_EVIDENCE],
    },
    GROOMING_EVIDENCE,
];

pub(super) fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes())
}

fn identifier(mut hasher: blake3::Hasher, bytes: &[u8]) -> [u8; 16] {
    hasher.update(bytes);
    let mut id = [0; 16];
    hasher.finalize_xof().fill(&mut id);
    id
}

impl Builtin {
    pub fn id(&self) -> AbilityId {
        AbilityId::from_bytes(identifier(
            blake3::Hasher::new_derive_key("notarium.system-ability.id.v1"),
            self.name.as_bytes(),
        ))
    }

    pub fn revision(&self) -> RevisionId {
        let mut hasher = blake3::Hasher::new_derive_key("notarium.system-ability.revision.v1");
        hasher.update(self.id().as_str().as_bytes());
        hasher.update(match self.kind {
            AbilityKind::Role => b"role",
            AbilityKind::Skill => b"skill",
        });
        hasher.update(digest(self.instructions.as_bytes()).as_bytes());
        for dependency in self.skills {
            hasher.update(dependency.revision().as_str().as_bytes());
        }
        RevisionId::from_bytes(identifier(hasher, &[]))
    }

    pub fn reference(&self) -> AbilityRef {
        AbilityRef {
            id: self.id(),
            placement: AbilityPlacement::System,
            revision: self.revision(),
        }
    }

    pub fn descriptor(&self) -> AbilityDescriptor {
        AbilityDescriptor {
            reference: self.reference(),
            name: self.name.to_owned(),
            kind: self.kind,
            enabled: true,
            healthy: true,
            lifecycle: Lifecycle::Active,
            entrypoint: None,
            auxiliary_files: Vec::new(),
            attached_skills: self.skills.iter().map(Self::reference).collect(),
        }
    }
}
