#[test]
fn markdown_lazy_continuations_preserve_tight_and_loose_lists() {
    use pulldown_cmark::{Options, Parser, html};
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (source, expected) in [
        (
            "> - first\nlazy\n> - second\n",
            "<blockquote>\n<ul>\n<li>first\nlazy</li>\n<li>second</li>\n</ul>\n</blockquote>\n",
        ),
        (
            "> - one\n>   continued\n> - two\n",
            "<blockquote>\n<ul>\n<li>one\ncontinued</li>\n<li>two</li>\n</ul>\n</blockquote>\n",
        ),
        (
            "> - one\n>\n>   continued\n>\n> - two\n",
            "<blockquote>\n<ul>\n<li>\n<p>one</p>\n<p>continued</p>\n</li>\n<li>\n<p>two</p>\n</li>\n</ul>\n</blockquote>\n",
        ),
    ] {
        let mut actual = String::new();
        html::push_html(&mut actual, Parser::new_ext(source, options));
        assert_eq!(actual, expected, "{source:?}");
    }
}

#[test]
fn deeply_nested_quotes_keep_lazy_text_source_ranges() {
    use notarium_core::span::ByteSpan;
    use notarium_syntax::markdown;
    let depth = 1024;
    let source = format!(
        "{}text\n{}",
        "> ".repeat(depth),
        "lazy line\n".repeat(depth)
    );
    let body = ByteSpan::new(0, source.len()).unwrap();
    let parsed = markdown::analyze(&source, body).unwrap();
    assert!(parsed.headings.is_empty());
    assert!(parsed.fences.is_empty());
    assert_eq!(parsed.blocks.len(), 1);
    assert_eq!(parsed.text_ranges.len(), depth + 1);
    assert_eq!(parsed.text_ranges[0].slice(&source).unwrap(), "text");
    for range in &parsed.text_ranges[1..] {
        assert_eq!(range.slice(&source).unwrap(), "lazy line");
    }
    assert!(
        parsed
            .text_ranges
            .windows(2)
            .all(|pair| pair[0].end() < pair[1].start())
    );
}
