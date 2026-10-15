//! A deck as a list of slide texts, changed one slide at a time. It mirrors
//! `DeckDraft` in the cloud server's `assistant/draft.ts`, so `edit_slides`
//! behaves the same on this computer and in the cloud, error messages included.

use std::fmt;

use crate::slides::{
    frontmatter_errors, join_slides, js_length, js_trim, slide_texts, split_slides,
    title_of_slide_text,
};

/// The longest deck, in UTF-16 units like JavaScript's `length`, that tools accept.
pub const MARKDOWN_MAX_LENGTH: usize = 100_000;

/// A change that would break the deck. The message tells Claude how to fix it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditError(pub String);

impl fmt::Display for EditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for EditError {}

/// Checks Markdown before it is saved: size, frontmatter YAML and that it
/// holds at least one slide. Mirrors `checkMarkdown` in `mcp/decks.ts`; the
/// cloud also builds the deck model there, which this side cannot, so a
/// deck it refuses for other reasons is accepted here.
pub fn check_markdown(markdown: &str) -> Result<(), String> {
    let length = js_length(markdown);
    if length > MARKDOWN_MAX_LENGTH {
        return Err(format!(
            "The deck is {length} characters long. The limit is {MARKDOWN_MAX_LENGTH}. Split it into several decks."
        ));
    }
    let problems = frontmatter_errors(markdown);
    if !problems.is_empty() {
        return Err(format!(
            "The frontmatter is not valid YAML. {}",
            problems.join(" ")
        ));
    }
    if split_slides(markdown).is_empty() {
        return Err("Deyslide cannot read this deck: it has no slides.".to_string());
    }
    Ok(())
}

fn check_number(number: u64, count: usize, label: &str) -> Result<usize, EditError> {
    match usize::try_from(number) {
        Ok(index) if (1..=count).contains(&index) => Ok(index - 1),
        _ => Err(EditError(format!(
            "There is no {label} {number}. The deck has {count} slides."
        ))),
    }
}

#[derive(Debug, Clone)]
pub struct DeckDraft {
    slides: Vec<String>,
}

impl DeckDraft {
    pub fn new(markdown: &str) -> Self {
        Self {
            slides: slide_texts(markdown),
        }
    }

    pub fn markdown(&self) -> String {
        join_slides(&self.slides)
    }

    pub fn count(&self) -> usize {
        self.slides.len()
    }

    /// Numbered slide titles, for tool results.
    pub fn outline(&self) -> String {
        self.slides
            .iter()
            .enumerate()
            .map(|(index, text)| format!("{}. {}", index + 1, title_of_slide_text(text)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The deck with each slide wrapped in `<slide number="N">`.
    pub fn numbered(&self) -> String {
        self.slides
            .iter()
            .enumerate()
            .map(|(index, text)| {
                format!(
                    "<slide number=\"{}\">\n{}\n</slide>",
                    index + 1,
                    js_trim(text)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub fn replace(&mut self, number: u64, text: &str) -> Result<(), EditError> {
        let index = check_number(number, self.count(), "slide")?;
        let text = single(text)?;
        let mut next = self.slides.clone();
        next[index] = text;
        self.change(next)
    }

    pub fn insert(&mut self, position: u64, text: &str) -> Result<(), EditError> {
        let index = check_number(position, self.count() + 1, "position")?;
        let text = single(text)?;
        let mut next = self.slides.clone();
        next.insert(index, text);
        self.change(next)
    }

    pub fn remove(&mut self, number: u64) -> Result<(), EditError> {
        let index = check_number(number, self.count(), "slide")?;
        if self.count() == 1 {
            return Err(EditError(
                "A deck needs at least one slide. Replace the last slide instead.".to_string(),
            ));
        }
        let mut next = self.slides.clone();
        next.remove(index);
        self.change(next)
    }

    pub fn move_slide(&mut self, from: u64, to: u64) -> Result<(), EditError> {
        let from = check_number(from, self.count(), "slide")?;
        let to = check_number(to, self.count(), "position")?;
        let mut next = self.slides.clone();
        let slide = next.remove(from);
        next.insert(to, slide);
        self.change(next)
    }

    /// Keeps the change only when the deck stays readable.
    fn change(&mut self, next: Vec<String>) -> Result<(), EditError> {
        let markdown = join_slides(&next);
        if js_length(&markdown) > MARKDOWN_MAX_LENGTH {
            return Err(EditError(format!(
                "The deck would be longer than {MARKDOWN_MAX_LENGTH} characters."
            )));
        }
        if split_slides(&markdown).is_empty() {
            return Err(EditError(
                "That change makes a deck Deyslide cannot read.".to_string(),
            ));
        }
        self.slides = next;
        Ok(())
    }
}

/// Normalizes one slide's text and refuses text that Slidev would read as several slides.
fn single(text: &str) -> Result<String, EditError> {
    let trimmed = js_trim(text);
    let count = slide_texts(trimmed).len();
    if count != 1 {
        return Err(EditError(format!(
            "That text makes {count} slides. Send one slide per call, without a --- separator between slides."
        )));
    }
    if let Some(problem) = frontmatter_errors(trimmed).first() {
        let problem = problem.strip_prefix("Slide 1: ").unwrap_or(problem);
        return Err(EditError(format!(
            "The frontmatter is not valid YAML: {problem}"
        )));
    }
    Ok(format!("{trimmed}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DECK: &str = "---\ntitle: Deck\n---\n\n# One\n\n---\n\n# Two\n\n---\n\n# Three\n";

    #[test]
    fn numbers_slides() {
        let draft = DeckDraft::new(DECK);
        assert_eq!(draft.count(), 3);
        assert!(draft.numbered().starts_with("<slide number=\"1\">\n---\ntitle: Deck\n---\n\n# One\n</slide>\n\n<slide number=\"2\">"));
        assert_eq!(draft.outline(), "1. One\n2. Two\n3. Three");
    }

    #[test]
    fn edits_in_order() {
        let mut draft = DeckDraft::new(DECK);
        draft.insert(4, "# Four").unwrap();
        draft.move_slide(4, 2).unwrap();
        draft.remove(3).unwrap();
        draft
            .replace(1, "---\ntitle: Deck\n---\n\n# Start")
            .unwrap();
        assert_eq!(draft.outline(), "1. Start\n2. Four\n3. Three");
        assert_eq!(
            draft.markdown(),
            "---\ntitle: Deck\n---\n\n# Start\n\n---\n\n# Four\n\n---\n\n# Three\n"
        );
    }

    #[test]
    fn refuses_what_would_break_the_deck() {
        let mut draft = DeckDraft::new(DECK);
        assert_eq!(
            draft.replace(9, "# Nine").unwrap_err().0,
            "There is no slide 9. The deck has 3 slides."
        );
        // Like the cloud server, an insert counts the place after the last slide.
        assert_eq!(
            draft.insert(5, "# Five").unwrap_err().0,
            "There is no position 5. The deck has 4 slides."
        );
        assert_eq!(
            draft.replace(1, "# A\n\n---\n\n# B").unwrap_err().0,
            "That text makes 2 slides. Send one slide per call, without a --- separator between slides."
        );
        assert!(draft
            .replace(1, "---\ntitle: [oops\n---\n# A")
            .unwrap_err()
            .0
            .starts_with("The frontmatter is not valid YAML: "));
        let mut single = DeckDraft::new("# Only\n");
        assert_eq!(
            single.remove(1).unwrap_err().0,
            "A deck needs at least one slide. Replace the last slide instead."
        );
        assert_eq!(draft.outline(), "1. One\n2. Two\n3. Three");
    }

    #[test]
    fn checks_whole_decks() {
        assert!(check_markdown(DECK).is_ok());
        assert!(check_markdown("---\ntitle: [oops\n---\n# A")
            .unwrap_err()
            .starts_with("The frontmatter is not valid YAML. Slide 1: "));
        let long = "a".repeat(MARKDOWN_MAX_LENGTH + 1);
        assert_eq!(
            check_markdown(&long).unwrap_err(),
            "The deck is 100001 characters long. The limit is 100000. Split it into several decks."
        );
    }
}
