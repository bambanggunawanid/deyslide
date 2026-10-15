//! Splits Slidev Markdown into slides and joins slides back into one
//! document, exactly like `@slidev/parser` 53 does with `parseSync` and
//! `stringify` (`dist/core.mjs`). The web app and the cloud server use that
//! parser, so a deck file reads the same in every part of Deyslide.
//!
//! Comments name the JavaScript each step mirrors. Line numbers are 0 based
//! and count lines the way JavaScript's `split(/\r?\n/)` does.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::yaml::read_yaml;

/// White space as JavaScript's `trim` and the regular expression `\s` see it.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// A string's `length` in JavaScript: its UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `text.slice(0, units)`, except that it never splits a
/// character that takes two UTF-16 units.
pub fn js_prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in text.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

/// Characters that end a line for JavaScript's `.` and `$` in regular expressions.
fn is_js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// How a slide's frontmatter was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontmatterStyle {
    /// Between `---` lines.
    Frontmatter,
    /// In a fenced `yaml` code block at the start of the slide.
    Yaml,
}

/// A slide as Slidev reads it from Markdown, with its place in the text.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSlide {
    pub index: usize,
    /// First line of the slide, including its frontmatter.
    pub start: usize,
    /// First line after the frontmatter.
    pub content_start: usize,
    /// The line after the slide: its separator, or the line count.
    pub end: usize,
    /// The slide's whole text: frontmatter, content and speaker notes.
    pub raw: String,
    /// The slide's Markdown without frontmatter and speaker notes.
    pub content: String,
    /// Speaker notes: the last HTML comment, when it ends the slide.
    pub note: Option<String>,
    /// The frontmatter as JSON, `{}` when there is none. Like Slidev, a
    /// document that is not a mapping (a list, a string) is kept as it is.
    pub frontmatter: Value,
    pub frontmatter_style: Option<FrontmatterStyle>,
    /// The frontmatter's YAML source.
    pub frontmatter_raw: Option<String>,
    /// Why the frontmatter's YAML cannot be read. Slidev skips such
    /// frontmatter instead of failing, so code that writes slides checks it.
    pub frontmatter_error: Option<String>,
}

/// `markdown.split(/\r?\n/)`.
fn split_lines(markdown: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = markdown.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// `advanceHtmlCommentState`: whether an HTML comment is still open at the end of a line.
fn advance_html_comment_state(line: &str, mut in_comment: bool) -> bool {
    let mut cursor = 0;
    while cursor < line.len() {
        if in_comment {
            match line[cursor..].find("-->") {
                None => return true,
                Some(end) => {
                    in_comment = false;
                    cursor += end + 3;
                }
            }
        } else {
            let Some(start) = line[cursor..].find("<!--") else {
                return false;
            };
            let start = cursor + start;
            match line[start + 4..].find("-->") {
                None => return true,
                Some(end) => cursor = start + 4 + end + 3,
            }
        }
    }
    in_comment
}

/// `line.match(/^\s*`+/)[0]`: the indent and backticks that open a code fence.
fn fence_opening(line: &str) -> &str {
    let indent = line.len() - js_trim_start(line).len();
    let ticks = line[indent..]
        .bytes()
        .take_while(|byte| *byte == b'`')
        .count();
    &line[..indent + ticks]
}

/// Splits Markdown into slides exactly as Slidev's `parseSync` does.
pub fn split_slides(markdown: &str) -> Vec<SourceSlide> {
    let lines = split_lines(markdown);
    let mut slides: Vec<SourceSlide> = Vec::new();
    let mut start = 0;
    let mut content_start = 0;
    let mut in_comment = false;

    let mut slice = |end: usize, start: &mut usize, content_start: &mut usize| {
        if *start == end {
            return;
        }
        let raw = if *start < end {
            lines[*start..end].join("\n")
        } else {
            String::new()
        };
        slides.push(parse_slide(raw, slides.len(), *start, *content_start, end));
        *start = end + 1;
        *content_start = end + 1;
    };

    let mut i = 0;
    while i < lines.len() {
        let raw_line = lines[i];
        let line = js_trim_end(raw_line);
        if in_comment {
            in_comment = advance_html_comment_state(raw_line, true);
            i += 1;
            continue;
        }
        if line.starts_with("---") {
            slice(i, &mut start, &mut content_start);
            let next_has_text = lines
                .get(i + 1)
                .is_some_and(|next| !js_trim(next).is_empty());
            if line.as_bytes().get(3) != Some(&b'-') && next_has_text {
                start = i;
                i += 1;
                while i < lines.len() {
                    if js_trim_end(lines[i]) == "---" {
                        break;
                    }
                    i += 1;
                }
                content_start = i + 1;
            }
        } else if js_trim_start(line).starts_with("```") {
            let opening = fence_opening(line);
            let mut j = i + 1;
            while j < lines.len() {
                if lines[j].starts_with(opening) {
                    break;
                }
                j += 1;
            }
            if j != lines.len() {
                i = j;
            }
        } else {
            in_comment = advance_html_comment_state(raw_line, false);
        }
        i += 1;
    }
    if start < lines.len() {
        slice(lines.len(), &mut start, &mut content_start);
    }
    slides
}

/// The text of each slide, with its frontmatter and speaker notes, as
/// Slidev reads it. The first slide's frontmatter is the deck's headmatter.
pub fn slide_texts(markdown: &str) -> Vec<String> {
    split_slides(markdown)
        .into_iter()
        .map(|slide| slide.raw)
        .collect()
}

/// Joins slide texts into one document like Slidev's `stringify`, the
/// reverse of [`slide_texts`]. Every slide after the first gets a `---`
/// separator unless its text already starts with one.
pub fn join_slides<S: AsRef<str>>(texts: &[S]) -> String {
    let parts: Vec<String> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let raw = text.as_ref();
            if raw.starts_with("---") || index == 0 {
                raw.to_string()
            } else if raw.starts_with('\n') {
                format!("---\n{raw}")
            } else {
                format!("---\n\n{raw}")
            }
        })
        .collect();
    format!("{}\n", js_trim(&parts.join("\n")))
}

/// YAML problems in each slide's frontmatter, as `Slide N: <problem>`.
pub fn frontmatter_errors(markdown: &str) -> Vec<String> {
    split_slides(markdown)
        .into_iter()
        .filter_map(|slide| {
            slide
                .frontmatter_error
                .map(|error| format!("Slide {}: {error}", slide.index + 1))
        })
        .collect()
}

/// A slide's title for outlines: its first line that is not empty and not
/// an HTML comment, without heading marks. Mirrors `titleOf` in the cloud
/// server's `mcp/tools.ts`, which reads a slide's content.
pub fn title_of(content: &str) -> String {
    let first = content
        .split('\n')
        .map(js_trim)
        .find(|line| !line.is_empty() && !line.starts_with("<!--"))
        .unwrap_or("");
    short_title(strip_heading(first))
}

/// A slide's title from its whole text, frontmatter included: its first
/// heading, else its first line. Mirrors `titleOf` in the cloud server's
/// `assistant/draft.ts`.
pub fn title_of_slide_text(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').map(js_trim).collect();
    let body = if lines.first() == Some(&"---") {
        // `lines.slice(lines.indexOf('---', 1) + 1)`, which keeps every line when there is no second `---`.
        match lines.iter().skip(1).position(|line| *line == "---") {
            Some(position) => &lines[position + 2..],
            None => &lines[..],
        }
    } else {
        &lines[..]
    };
    let heading = body.iter().find(|line| heading_marks(line).is_some());
    let first = heading
        .or_else(|| {
            body.iter()
                .find(|line| !line.is_empty() && !line.starts_with("<!--"))
        })
        .copied()
        .unwrap_or("");
    short_title(strip_heading(first))
}

/// The length of the `#{1,6}` run when a line starts like a Markdown heading (`/^#{1,6}\s/`).
fn heading_marks(line: &str) -> Option<usize> {
    let marks = line.bytes().take_while(|byte| *byte == b'#').count();
    let follows_space = line[marks..].chars().next().is_some_and(is_js_space);
    ((1..=6).contains(&marks) && follows_space).then_some(marks)
}

/// `line.replace(/^#{1,6}\s+/, '')`.
fn strip_heading(line: &str) -> &str {
    match heading_marks(line) {
        Some(marks) => js_trim_start(&line[marks..]),
        None => line,
    }
}

/// `title.slice(0, 80) || '(empty)'`.
fn short_title(title: &str) -> String {
    let title = js_prefix(title, 80);
    if title.is_empty() {
        "(empty)".to_string()
    } else {
        title.to_string()
    }
}

/// What `matter` in Slidev's parser finds at the start of a slide.
struct Matter {
    style: Option<FrontmatterStyle>,
    raw: Option<String>,
    content: String,
}

/// `matter`: takes frontmatter off the start of a slide, either
/// `/^---.*\r?\n([\s\S]*?)---/` or `/^\s*```ya?ml([\s\S]*?)```/`. Neither
/// needs its closing marker at the start of a line.
fn matter(code: &str) -> Matter {
    if let Some(rest) = code.strip_prefix("---") {
        if let Some(stop) = rest.find(is_js_line_end) {
            let after = &rest[stop..];
            let newline = if after.starts_with("\r\n") {
                Some(2)
            } else if after.starts_with('\n') {
                Some(1)
            } else {
                None
            };
            if let Some(newline) = newline {
                let body = 3 + stop + newline;
                if let Some(close) = code[body..].find("---") {
                    return Matter {
                        style: Some(FrontmatterStyle::Frontmatter),
                        raw: Some(code[body..body + close].to_string()),
                        content: code[body + close + 3..].to_string(),
                    };
                }
            }
        }
    }
    let indent = code.len() - js_trim_start(code).len();
    let fence = &code[indent..];
    let opening = if fence.starts_with("```yaml") {
        Some(7)
    } else if fence.starts_with("```yml") {
        Some(6)
    } else {
        None
    };
    if let Some(opening) = opening {
        let body = indent + opening;
        if let Some(close) = code[body..].find("```") {
            return Matter {
                style: Some(FrontmatterStyle::Yaml),
                raw: Some(code[body..body + close].to_string()),
                content: code[body + close + 3..].to_string(),
            };
        }
    }
    Matter {
        style: None,
        raw: None,
        content: code.to_string(),
    }
}

/// The last `<!--...-->` in the text: where it starts, where it ends and what it holds.
fn last_comment(text: &str) -> Option<(usize, usize, &str)> {
    let mut found = None;
    let mut cursor = 0;
    while let Some(open) = text[cursor..].find("<!--") {
        let open = cursor + open;
        let Some(close) = text[open + 4..].find("-->") else {
            break;
        };
        let close = open + 4 + close;
        found = Some((open, close + 3, &text[open + 4..close]));
        cursor = close + 3;
    }
    found
}

/// `parseSlide`, without the parts Deyslide does not use (title, images).
fn parse_slide(
    raw: String,
    index: usize,
    start: usize,
    content_start: usize,
    end: usize,
) -> SourceSlide {
    let matter = matter(&raw);
    let mut content = js_trim(&matter.content).to_string();
    let mut note = None;
    if let Some((open, close, inner)) = last_comment(&content) {
        if close >= content.len() {
            note = Some(js_trim(inner).to_string());
            content = js_trim(&content[..open]).to_string();
        }
    }
    let (frontmatter, frontmatter_error) = match matter.raw.as_deref() {
        Some(yaml) if !yaml.is_empty() => match read_yaml(yaml) {
            Ok(value) => (value, None),
            Err(error) => (Value::Object(Map::new()), Some(error)),
        },
        _ => (Value::Object(Map::new()), None),
    };
    SourceSlide {
        index,
        start,
        content_start,
        end,
        raw,
        content,
        note,
        frontmatter,
        frontmatter_style: matter.style,
        frontmatter_raw: matter.raw,
        frontmatter_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(markdown: &str) -> Vec<String> {
        slide_texts(markdown)
    }

    #[test]
    fn splits_on_separator_lines() {
        let slides = split_slides("# One\n\n---\n\n# Two\n");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[0].content, "# One");
        assert_eq!((slides[0].start, slides[0].end), (0, 2));
        assert_eq!(slides[1].raw, "\n# Two\n");
        assert_eq!((slides[1].start, slides[1].end), (3, 6));
    }

    #[test]
    fn reads_frontmatter_after_a_separator() {
        let slides = split_slides("# One\n---\nlayout: center\nclass: big\n---\n# Two");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[1].start, 1);
        assert_eq!(slides[1].content_start, 5);
        assert_eq!(slides[1].raw, "---\nlayout: center\nclass: big\n---\n# Two");
        assert_eq!(
            slides[1].frontmatter,
            serde_json::json!({ "layout": "center", "class": "big" })
        );
        assert_eq!(slides[1].content, "# Two");
        assert_eq!(
            slides[1].frontmatter_style,
            Some(FrontmatterStyle::Frontmatter)
        );
    }

    #[test]
    fn a_separator_before_a_blank_line_opens_no_frontmatter() {
        let slides = split_slides("# One\n---\n\nlayout: center\n");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[1].content, "layout: center");
        assert_eq!(slides[1].frontmatter, serde_json::json!({}));
    }

    #[test]
    fn four_dashes_never_open_frontmatter() {
        let slides = split_slides("# One\n----\nlayout: center\n");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[1].content, "layout: center");
    }

    #[test]
    fn code_fences_and_comments_hide_separators() {
        let markdown = "```md\n---\n```\n<!--\n---\n-->\n````\n```\n---\n```\n````\n---\n# Two";
        assert_eq!(texts(markdown).len(), 2);
    }

    #[test]
    fn a_fence_that_never_closes_hides_nothing() {
        assert_eq!(texts("```ts\nlet a = 1\n---\n# Two").len(), 2);
    }

    #[test]
    fn an_open_comment_swallows_the_rest() {
        assert_eq!(texts("# One\n<!--\n---\n# Two\n---\n# Three").len(), 1);
    }

    #[test]
    fn notes_are_the_last_comment_when_it_ends_the_slide() {
        let slides = split_slides("# One\n\n<!-- first -->\n\nText\n\n<!--\nSay this\n-->\n");
        assert_eq!(slides[0].note.as_deref(), Some("Say this"));
        assert_eq!(slides[0].content, "# One\n\n<!-- first -->\n\nText");
        let slides = split_slides("<!-- not a note -->\n\n# One");
        assert_eq!(slides[0].note, None);
    }

    #[test]
    fn a_yaml_block_counts_as_frontmatter() {
        let slides = split_slides("```yaml\nlayout: center\n```\n# One");
        assert_eq!(
            slides[0].frontmatter,
            serde_json::json!({ "layout": "center" })
        );
        assert_eq!(slides[0].frontmatter_style, Some(FrontmatterStyle::Yaml));
        assert_eq!(slides[0].content, "# One");
    }

    #[test]
    fn carriage_returns_before_newlines_are_dropped() {
        let slides = split_slides("# One\r\n---\r\n\r\n# Two\r\n");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[1].raw, "\n# Two\n");
    }

    #[test]
    fn a_leading_empty_slide_disappears_like_in_slidev() {
        let joined = join_slides(&["", "# Two\n"]);
        assert_eq!(joined, "---\n\n# Two\n");
        let slides = split_slides(&joined);
        assert_eq!(slides.len(), 1);
        assert_eq!(slides[0].content, "---\n\n# Two");
    }

    #[test]
    fn joining_adds_separators_like_slidev() {
        assert_eq!(
            join_slides(&[
                "---\ntitle: A\n---\n\n# A\n",
                "# B\n",
                "\n# C\n",
                "---\nlayout: end\n---\n"
            ]),
            "---\ntitle: A\n---\n\n# A\n\n---\n\n# B\n\n---\n\n# C\n\n---\nlayout: end\n---\n"
        );
    }

    #[test]
    fn slide_texts_and_join_round_trip() {
        let markdown = "---\ntitle: Deck\n---\n\n# One\n\n---\n\n# Two\n\n<!--\nnotes\n-->\n";
        assert_eq!(join_slides(&slide_texts(markdown)), markdown);
    }

    #[test]
    fn reports_broken_frontmatter_per_slide() {
        let errors = frontmatter_errors("# One\n\n---\ntitle: [oops\n---\n\n# Two\n");
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("Slide 2: "), "{errors:?}");
        assert!(frontmatter_errors("---\ntitle: fine\n---\n# One").is_empty());
    }

    #[test]
    fn a_blank_line_with_a_tab_is_fine_like_in_slidev() {
        let slides = split_slides("---\nlayout: center\n\t\nclass: big\n---\n# One");
        assert_eq!(slides[0].frontmatter_error, None);
        assert_eq!(
            slides[0].frontmatter,
            serde_json::json!({ "layout": "center", "class": "big" })
        );
    }

    #[test]
    fn non_mapping_frontmatter_is_kept_like_slidev() {
        let slides = split_slides("---\n- one\n- two\n---\n# One");
        assert_eq!(slides[0].frontmatter, serde_json::json!(["one", "two"]));
        let slides = split_slides("---\n0\n---\n# One");
        assert_eq!(slides[0].frontmatter, serde_json::json!({}));
    }

    #[test]
    fn titles_match_the_cloud_server() {
        assert_eq!(title_of("<!-- hi -->\n\n## Plan\n\nText"), "Plan");
        assert_eq!(title_of(""), "(empty)");
        assert_eq!(title_of("####### Seven"), "####### Seven");
        assert_eq!(
            title_of_slide_text("---\nlayout: cover\n---\n\nIntro\n\n# Heading\n"),
            "Heading"
        );
        assert_eq!(title_of_slide_text("Just text\n"), "Just text");
        assert_eq!(title_of(&"a".repeat(100)).len(), 80);
    }

    #[test]
    fn javascript_string_helpers() {
        assert_eq!(js_trim("\u{feff}\u{a0} text \u{2028}"), "text");
        assert_eq!(js_length("a😀"), 3);
        assert_eq!(js_prefix("a😀b", 2), "a");
        assert_eq!(js_prefix("a😀b", 3), "a😀");
    }
}
