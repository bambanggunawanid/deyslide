## Deyslide on this computer

This server is Deyslide on this computer. It works on decks saved as Markdown files in the person's Deyslide library folder instead of decks in an account.

- Each project is a folder in the library, and each deck is a .md file inside a project folder. list_decks shows where every file is.
- These decks have no editor links and nobody else can see them. When you finish, give the person the file path and tell them they can open it in the Deyslide app.
- People may work on a deck in the app or in another editor at the same time as you. write_deck and edit_slides refuse to save over a file that no longer holds what you last read or wrote. Call read_deck before your first edit, and again whenever a tool answers that the deck changed on disk.
- render_slides draws slides in the Deyslide app. It opens the app when it is closed, and the app's window must stay open while it draws. When no app answers, your changes are still saved: check the Markdown with read_deck instead.
- Frontmatter YAML is checked like Slidev reads it, with a few rare exceptions this server refuses: nesting deeper than 128 levels, a key left empty, and a tab inside a line's indentation. Write those parts more plainly.
