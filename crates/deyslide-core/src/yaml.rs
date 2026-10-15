//! Reads frontmatter YAML the way the `yaml` package does, which Slidev's
//! parser and deck-model use. The reader underneath is libyaml (through
//! `serde_norway`), and the two disagree on a few inputs:
//!
//! - libyaml refuses a tab at the start of an empty line or a comment.
//!   `yaml` reads such a line as empty, except inside a block scalar, inside
//!   a plain value that goes on after it, and after a key with no value when
//!   what follows starts right under that key.
//! - `yaml` refuses a quoted value or a `[ ]` or `{ }` list that goes on to
//!   more lines unless those lines are indented more than its key, or its
//!   `-` in a list. libyaml accepts any indentation there.
//! - libyaml refuses control characters, and reads U+0085, U+2028, U+2029
//!   and a carriage return on its own as line breaks. `yaml` keeps all of
//!   them as text.
//! - libyaml hands over whole numbers past 64 bits, which `yaml` reads as
//!   JavaScript numbers.
//!
//! [`read_yaml`] smooths these over before and after libyaml reads the
//! text. A few rare differences remain, and the parity scenario in
//! `features/slide-split-parity.feature` pins them: libyaml refuses nesting
//! deeper than 128 levels, a key left empty (`: value`), and a tab between
//! the spaces and the text of a line under a key with no value. It accepts
//! `1` and `01` as two keys, which `yaml` reads as the same number. Values
//! differ for `01`, text here and 1 there, and for numbers too large for a
//! float, such as `1e400`: text here, `null` in Slidev.

use std::fmt;

use serde::de::{self, DeserializeSeed, Deserializer, EnumAccess, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

/// Reads frontmatter YAML into JSON, keeping Slidev's `data || {}`: a
/// document that is empty, `false`, `0` or an empty string counts as none.
pub fn read_yaml(yaml: &str) -> Result<Value, String> {
    let prepared = prepare(yaml)?;
    let json = serde_norway::Deserializer::from_str(&prepared.text)
        .deserialize_any(JsonVisitor {
            stand_ins: prepared.stand_ins,
        })
        .map_err(|error| {
            let message = error.to_string();
            message.lines().next().unwrap_or_default().to_string()
        })?;
    let truthy = match &json {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    };
    Ok(if truthy {
        json
    } else {
        Value::Object(Map::new())
    })
}

/// The text libyaml reads, and whether characters in it stand in for others.
struct Prepared {
    text: String,
    stand_ins: bool,
}

/// Characters `yaml` keeps as text that libyaml refuses or reads as line
/// breaks. Carriage returns left after `\r\n` became `\n` are among them.
fn needs_stand_in(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{8}'
            | '\u{b}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{fffe}'
            | '\u{ffff}'
    )
}

/// Stand-ins live in the private use plane 15 at `STAND_IN + c`, which
/// libyaml reads as ordinary text. `needs_stand_in` only matches characters
/// below U+10000, so every stand-in is in that plane.
const STAND_IN: u32 = 0xF_0000;

fn is_stand_in(c: char) -> bool {
    (STAND_IN..=STAND_IN + 0xFFFF).contains(&u32::from(c))
}

fn stand_in(c: char) -> char {
    char::from_u32(STAND_IN + u32::from(c)).unwrap_or(c)
}

fn put_back(text: String) -> String {
    if !text.chars().any(is_stand_in) {
        return text;
    }
    text.chars()
        .map(|c| {
            if is_stand_in(c) {
                char::from_u32(u32::from(c) - STAND_IN).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// What the line before left open.
enum Mode {
    Block,
    /// Inside a `|` or `>` block scalar whose key or `-` sits at column `owner`.
    BlockScalar {
        owner: Option<usize>,
    },
    /// After a plain value, which goes on in the lines indented past `owner`.
    Plain {
        owner: Option<usize>,
    },
    /// After a key at column `owner` with nothing after its `:`.
    Empty {
        owner: usize,
    },
    /// Inside a quoted value or a flow collection that started on line
    /// `start` (counted from 1). Lines that go on with it must be indented
    /// more than `owner`, the column of its key or `-`, when it has one.
    Flow {
        owner: Option<usize>,
        start: usize,
        scan: FlowScan,
    },
}

/// Follows quotes and brackets through a flow value, line after line.
#[derive(Clone, Copy)]
struct FlowScan {
    quote: Option<char>,
    depth: usize,
    /// The last character that was not white space, for telling a quote
    /// that opens a value from an apostrophe inside plain text.
    last: char,
}

impl FlowScan {
    /// Starts at a `"`, `'`, `[` or `{`.
    fn new() -> Self {
        Self {
            quote: None,
            depth: 0,
            last: ',',
        }
    }

    /// Reads `text`, returning where the value ends when it ends on this line.
    fn feed(&mut self, text: &str) -> Option<usize> {
        let mut chars = text.char_indices().peekable();
        let mut previous = ' ';
        while let Some((index, c)) = chars.next() {
            match self.quote {
                Some('"') => match c {
                    '\\' => {
                        chars.next();
                    }
                    '"' => self.quote = None,
                    _ => {}
                },
                Some(_) => {
                    if c == '\'' {
                        if chars.peek().is_some_and(|(_, next)| *next == '\'') {
                            chars.next();
                        } else {
                            self.quote = None;
                        }
                    }
                }
                None => match c {
                    '#' if previous == ' ' || previous == '\t' => return None,
                    '"' | '\'' if matches!(self.last, '[' | '{' | ',' | ':' | '?') => {
                        self.quote = Some(c);
                    }
                    '[' | '{' => self.depth += 1,
                    ']' | '}' => self.depth = self.depth.saturating_sub(1),
                    _ => {}
                },
            }
            if c != ' ' && c != '\t' {
                self.last = c;
            }
            previous = c;
            if self.quote.is_none() && self.depth == 0 {
                return Some(index + c.len_utf8());
            }
        }
        None
    }
}

/// The spaces at the start of a line, before anything else.
fn spaces(line: &str) -> usize {
    line.bytes().take_while(|byte| *byte == b' ').count()
}

fn skip_blanks(line: &str, from: usize) -> usize {
    from + line[from..]
        .bytes()
        .take_while(|byte| *byte == b' ' || *byte == b'\t')
        .count()
}

/// Whether `text` opens a block scalar: `|` or `>`, then indicators, then
/// nothing but white space or a comment.
fn is_block_header(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(['|', '>']) else {
        return false;
    };
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == '+' || c == '-');
    rest.is_empty() || rest.starts_with([' ', '\t'])
}

/// Where a plain key ends: its `:` followed by white space or the line's end.
fn plain_key_end(line: &str, from: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut index = from;
    while index < bytes.len() {
        match bytes[index] {
            b'#' if index > from && matches!(bytes[index - 1], b' ' | b'\t') => return None,
            b':' if matches!(bytes.get(index + 1), None | Some(b' ' | b'\t')) => {
                return Some(index)
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Skips `&anchor` and `!tag` before a value.
fn skip_properties(line: &str, mut at: usize) -> usize {
    while line[at..].starts_with(['&', '!']) {
        let end = line[at..]
            .find([' ', '\t'])
            .map_or(line.len(), |end| at + end);
        at = skip_blanks(line, end);
    }
    at
}

/// What a line in block context opens for the lines after it.
fn open_after(line: &str, number: usize) -> Mode {
    let mut at = spaces(line);
    let mut owner = None;
    // `- ` entries, maybe several on one line.
    while line[at..].starts_with('-')
        && matches!(line.as_bytes().get(at + 1), None | Some(b' ' | b'\t'))
    {
        owner = Some(at);
        at = skip_blanks(line, at + 1);
    }
    // A key, plain or quoted, moves the owner to the key's column.
    let mut key = None;
    let rest = &line[at..];
    if rest.starts_with(['"', '\'']) {
        let mut scan = FlowScan::new();
        match scan.feed(rest) {
            None => {
                return Mode::Flow {
                    owner,
                    start: number,
                    scan,
                }
            }
            Some(end) => {
                let after = skip_blanks(line, at + end);
                let is_key = line[after..].starts_with(':')
                    && matches!(line.as_bytes().get(after + 1), None | Some(b' ' | b'\t'));
                if !is_key {
                    return Mode::Block;
                }
                key = Some(at);
                at = skip_blanks(line, after + 1);
            }
        }
    } else if !rest.is_empty() && !rest.starts_with(['[', '{', '|', '>', '#']) {
        match plain_key_end(line, at) {
            Some(colon) => {
                key = Some(at);
                at = skip_blanks(line, colon + 1);
            }
            None => return Mode::Plain { owner },
        }
    }
    let owner = key.or(owner);
    let at = skip_properties(line, at);
    let value = &line[at..];
    if value.is_empty() || value.starts_with('#') {
        return match key {
            Some(owner) => Mode::Empty { owner },
            None => Mode::Block,
        };
    }
    if is_block_header(value) {
        return Mode::BlockScalar { owner };
    }
    if value.starts_with(['"', '\'', '[', '{']) {
        let mut scan = FlowScan::new();
        if scan.feed(value).is_none() {
            return Mode::Flow {
                owner,
                start: number,
                scan,
            };
        }
        return Mode::Block;
    }
    Mode::Plain { owner }
}

fn indentation_problem(line: usize, owner: usize, start: usize) -> String {
    let needed = owner + 1;
    format!(
        "line {line} needs at least {needed} space{} of indentation, because it continues the value that starts on line {start}",
        if needed == 1 { "" } else { "s" }
    )
}

/// Rewrites the YAML so libyaml reads it like `yaml`, or says why `yaml`
/// would refuse it where libyaml would not.
fn prepare(yaml: &str) -> Result<Prepared, String> {
    // Both read `\r\n` as one line break. A carriage return on its own gets a stand-in below.
    let yaml = yaml.replace("\r\n", "\n");
    let source: Vec<&str> = yaml.split('\n').collect();
    // For each line, the next line with text, and the next one that is not a comment indented with a tab.
    let mut next_text = vec![None; source.len()];
    let mut next_entry = vec![None; source.len()];
    for index in (0..source.len().saturating_sub(1)).rev() {
        let after = source[index + 1];
        let lead = skip_blanks(after, 0);
        let has_text = lead < after.len();
        let tabbed_comment = after[..lead].contains('\t') && after[lead..].starts_with('#');
        next_text[index] = if has_text {
            Some(after)
        } else {
            next_text[index + 1]
        };
        next_entry[index] = if has_text && !tabbed_comment {
            Some(after)
        } else {
            next_entry[index + 1]
        };
    }
    let mut lines: Vec<String> = Vec::new();
    let mut mode = Mode::Block;
    for (index, &line) in source.iter().enumerate() {
        let number = index + 1;
        let lead = skip_blanks(line, 0);
        let blank = lead == line.len();
        if let Mode::Empty { owner } = mode {
            // After a key with no value, `yaml` refuses an empty line that
            // starts with a tab when the next line, comments with tabs left
            // aside, starts right under the key. libyaml refuses such a
            // line anywhere, so there it stays as it is.
            let under_key = next_entry[index].is_some_and(|next| spaces(next) == owner);
            if blank && line.starts_with('\t') && under_key {
                lines.push(line.to_string());
                continue;
            }
        }
        if let Mode::Plain { owner } = mode {
            let goes_on = |line: &str| owner.is_none_or(|owner| spaces(line) > owner);
            if blank {
                // `yaml` refuses a tab on an empty line inside a plain value that goes on after it.
                let inside = next_text[index].is_some_and(goes_on);
                let tab = line.contains('\t');
                lines.push(if tab && !inside {
                    String::new()
                } else {
                    line.to_string()
                });
                continue;
            }
            if goes_on(line) {
                lines.push(line.to_string());
                continue;
            }
            mode = Mode::Block;
        }
        if let Mode::BlockScalar { owner } = mode {
            // Lines indented past the owner, and empty ones, belong to the scalar as they are.
            if blank || owner.is_none_or(|owner| spaces(line) > owner) {
                lines.push(line.to_string());
                continue;
            }
            mode = Mode::Block;
        }
        if let Mode::Flow {
            owner,
            start,
            ref mut scan,
        } = mode
        {
            if let Some(owner) = owner {
                let indent = spaces(line);
                // A last `]` or `}` may sit right under the key, after tabs too.
                let closes =
                    scan.quote.is_none() && scan.depth == 1 && line[lead..].starts_with([']', '}']);
                let tab_in_quote = blank && scan.quote.is_some() && line.contains('\t');
                // Between the items of a list, a comment line may sit anywhere.
                let comment = scan.quote.is_none() && line[lead..].starts_with('#');
                let short = if blank {
                    tab_in_quote && indent <= owner
                } else if comment {
                    false
                } else {
                    indent <= owner && !(closes && indent >= owner)
                };
                if short {
                    return Err(indentation_problem(number, owner, start));
                }
            }
            lines.push(line.to_string());
            if scan.feed(line).is_some() {
                mode = Mode::Block;
            }
            continue;
        }
        // Block context: a tab before nothing or before a comment reads as an empty line.
        if line[..lead].contains('\t') && (blank || line[lead..].starts_with('#')) {
            lines.push(String::new());
            continue;
        }
        lines.push(line.to_string());
        if !blank {
            mode = open_after(line, number);
        }
    }
    let text = lines.join("\n");
    // Stand-ins are only used when the text holds none of its own, so every one found later is ours.
    let stand_ins = text.chars().any(needs_stand_in) && !text.chars().any(is_stand_in);
    let text = if stand_ins {
        text.chars()
            .map(|c| if needs_stand_in(c) { stand_in(c) } else { c })
            .collect()
    } else {
        text
    };
    Ok(Prepared { text, stand_ins })
}

/// Builds JSON straight from libyaml's events, like `doc.toJSON()` then
/// `JSON.stringify` in JavaScript: numbers past 64 bits become floats,
/// stand-ins turn back into their characters, and keys must be unique.
#[derive(Clone, Copy)]
struct JsonVisitor {
    stand_ins: bool,
}

impl JsonVisitor {
    fn text(self, text: String) -> String {
        if self.stand_ins {
            put_back(text)
        } else {
            text
        }
    }
}

impl<'de> DeserializeSeed<'de> for JsonVisitor {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

fn float(value: f64) -> Value {
    // JSON.stringify writes NaN and the infinities as null.
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// Keys `yaml` sees as the same: equal values, numbers compared as numbers.
fn same_key(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => left == right,
    }
}

/// A key as a JavaScript object key.
fn key_text(key: &Value) -> String {
    match key {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any YAML value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_i128<E: de::Error>(self, value: i128) -> Result<Value, E> {
        Ok(float(value as f64))
    }

    fn visit_u128<E: de::Error>(self, value: u128) -> Result<Value, E> {
        Ok(float(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(float(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(self.text(value.to_string())))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(self.text(value)))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = items.next_element_seed(self)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<Value, A::Error> {
        let mut keys: Vec<Value> = Vec::new();
        let mut object = Map::new();
        while let Some(key) = entries.next_key_seed(self)? {
            if keys.iter().any(|seen| same_key(seen, &key)) {
                return Err(de::Error::custom(format!(
                    "duplicate key {key}: map keys must be unique"
                )));
            }
            let value = entries.next_value_seed(self)?;
            object.insert(key_text(&key), value);
            keys.push(key);
        }
        Ok(Value::Object(object))
    }

    /// A value with a tag `yaml` does not know: the tag is dropped.
    fn visit_enum<A: EnumAccess<'de>>(self, data: A) -> Result<Value, A::Error> {
        let (_tag, contents) = data.variant::<String>()?;
        de::VariantAccess::newtype_variant_seed(contents, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read(yaml: &str) -> Result<Value, String> {
        read_yaml(yaml)
    }

    #[test]
    fn reads_mappings_lists_and_scalars() {
        assert_eq!(
            read("title: Deck\nfonts:\n  sans: Inter\nclicks: 2\nlist: [a, b]\n").unwrap(),
            json!({ "title": "Deck", "fonts": { "sans": "Inter" }, "clicks": 2, "list": ["a", "b"] })
        );
        assert_eq!(read("").unwrap(), json!({}));
        assert_eq!(read("- one\n- two").unwrap(), json!(["one", "two"]));
        assert_eq!(read("x: !custom hello").unwrap(), json!({ "x": "hello" }));
    }

    #[test]
    fn tabs_before_nothing_or_a_comment_read_as_empty_lines() {
        assert_eq!(
            read("theme: default\n\t# keep\n\t\nclass: big").unwrap(),
            json!({ "theme": "default", "class": "big" })
        );
        assert_eq!(
            read("fonts:\n  sans: Inter\n\t# mono later").unwrap(),
            json!({ "fonts": { "sans": "Inter" } })
        );
    }

    #[test]
    fn block_scalars_keep_their_lines() {
        assert_eq!(
            read("info: |\n  x\n  \t\n  y\n").unwrap(),
            json!({ "info": "x\n\t\ny\n" })
        );
        assert!(read("info: |\n  ## Slidev\n\t\n  Text").is_err());
        assert_eq!(
            read("a: >-\n  x\n# c\nb: 1").unwrap(),
            json!({ "a": "x", "b": 1 })
        );
    }

    #[test]
    fn values_on_more_lines_must_be_indented_past_their_key() {
        for bad in [
            "title: \"A long\ntitle\"",
            "title: 'A long\ntitle'",
            "transition: [slide-left,\nfade]",
            "fonts: { sans: Inter,\nmono: Fira }",
            "a:\n  b: \"x\n  y\"",
            "- \"a\nb\"",
            "- - \"a\n  b\"",
            "- b: \"x\n  y\"",
            "a: \"x\\\"\ny\"",
            "a: \"x\n\ty\"",
            "a: \"x\n\t\n y\"",
            "a: [x, [y,\n]]",
            "a:\n  b: [x,\n]",
        ] {
            assert!(read(bad).is_err(), "{bad:?} should be refused");
        }
        assert_eq!(
            read("title: \"A long\n  title\"").unwrap(),
            json!({ "title": "A long title" })
        );
        assert_eq!(read("a: [x,\n]").unwrap(), json!({ "a": ["x"] }));
        assert_eq!(read("a: [x,\n\t\n y]").unwrap(), json!({ "a": ["x", "y"] }));
        assert_eq!(
            read("a: [it's,\n b]").unwrap(),
            json!({ "a": ["it's", "b"] })
        );
        assert_eq!(read("\"a\nb\"").unwrap(), json!("a b"));
        assert_eq!(
            read("a: \"x # y\n z\" # note").unwrap(),
            json!({ "a": "x # y z" })
        );
        assert_eq!(
            read("title: \"A long\ntitle\"").unwrap_err(),
            "line 2 needs at least 1 space of indentation, because it continues the value that starts on line 1"
        );
    }

    #[test]
    fn plain_values_on_more_lines_are_read_as_text() {
        assert_eq!(
            read("title: Steps\n  - [one,\n  two]").unwrap(),
            json!({ "title": "Steps - [one, two]" })
        );
        assert!(read("title: a\n\t\n b").is_err());
        assert_eq!(read("a: b\n\t\n").unwrap(), json!({ "a": "b" }));
    }

    #[test]
    fn a_tab_line_after_a_key_with_no_value() {
        assert!(read("a:\n\t\nb: 1").is_err());
        assert!(read("a:\n  b:\n\t\n  c: 1").is_err());
        assert_eq!(read("a:\n\t\n").unwrap(), json!({ "a": null }));
        assert_eq!(read("a:\n\t\n  b: 1").unwrap(), json!({ "a": { "b": 1 } }));
        assert_eq!(
            read("a:\n  b:\n\t\nc: 1").unwrap(),
            json!({ "a": { "b": null }, "c": 1 })
        );
        assert_eq!(
            read("a:\n\t# c\nb: 1").unwrap(),
            json!({ "a": null, "b": 1 })
        );
    }

    #[test]
    fn many_empty_lines_are_read_quickly() {
        let started = std::time::Instant::now();
        let yaml = format!(
            "title: a\n{}b: 1\nc:\n{}  d: 2",
            "\t\n".repeat(30_000),
            "\t\n".repeat(30_000)
        );
        assert_eq!(
            read(&yaml).unwrap(),
            json!({ "title": "a", "b": 1, "c": { "d": 2 } })
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn windows_line_breaks_are_line_breaks() {
        assert_eq!(
            read("title: A\r\nlayout: cover\r\n").unwrap(),
            json!({ "title": "A", "layout": "cover" })
        );
    }

    #[test]
    fn characters_libyaml_refuses_are_kept_as_text() {
        for text in [
            "a\u{7}b",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "a\rb",
            "a\u{7f}b",
            "a\u{ffff}b",
        ] {
            assert_eq!(
                read(&format!("title: {text}")).unwrap(),
                json!({ "title": text }),
                "{text:?}"
            );
        }
        assert_eq!(read("a\u{7}: b").unwrap(), json!({ "a\u{7}": "b" }));
    }

    #[test]
    fn numbers_past_64_bits_become_floats() {
        assert_eq!(
            read("seed: 99999999999999999999\nlow: -99999999999999999999").unwrap(),
            json!({ "seed": 1e20, "low": -1e20 })
        );
    }

    #[test]
    fn keys_must_be_unique() {
        assert!(read("layout: cover\nlayout: center").is_err());
        assert!(read("1: a\n1.0: b").is_err());
        assert_eq!(read("1: a\n\"1\": b").unwrap(), json!({ "1": "b" }));
    }
}
