Feature: Deyslide MCP server on this computer
  As a person who uses Claude Code on their computer
  I want Claude Code to write decks saved as files in my Deyslide library
  So that I can build talks on this computer, with or without an account

  Background:
    Given an empty Deyslide library and data folder
    And Claude Code runs deyslide-mcp on them

  Scenario: The tools match the hosted server
    Then the server calls itself "deyslide-local" with the title "Deyslide (this computer)"
    And it offers the hosted server's tools with the same titles, annotations and input schemas
    And create_deck and read_deck have the hosted descriptions with "file path" in place of "editor link"
    And list_decks describes the library folder, written against today's hosted description
    And write_deck says a read comes first, written against today's hosted description
    And every other tool has the hosted description

  Scenario: The guide and instructions add a part about this computer
    Then get_guide returns the hosted guide followed by the device appendix
    And the server's instructions are the hosted instructions followed by the device appendix
    And the copies in the Rust crate are what pnpm guide:sync writes today

  Scenario: Create a project and a deck
    When Claude Code creates the project "Lectures" and in it the deck "Recursion" with 3 slides
    Then the file "Lectures/Recursion.md" in the library holds that Markdown
    And the answer gives the deck's id and file path

  Scenario: A deck without Markdown starts with a title slide
    Given the library has the project "Talks"
    When Claude Code creates the deck "Sorting" in "Talks" without Markdown
    Then the file "Talks/Sorting.md" holds one cover slide titled "Sorting"

  Scenario: List decks with their files
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the library also holds a hidden folder, a text file and a Markdown file outside any project
    When Claude Code lists the decks
    Then it shows only the deck "Sorting" with 5 slides and the path of its file

  Scenario: Read a deck with numbered slides
    Given the library has the demo deck "Sorting" in the project "Talks"
    When Claude Code reads the deck "Sorting"
    Then it gets 5 slides wrapped in numbered slide tags and the file path

  Scenario: Write a whole deck
    Given the library has the demo deck "Sorting" in the project "Talks"
    When Claude Code reads the deck "Sorting" and writes a 2 slide deck in its place
    Then the file holds exactly that deck

  Scenario: Edits land in one batch
    Given the library has the demo deck "Sorting" in the project "Talks"
    And Claude Code read the deck "Sorting"
    When Claude Code adds a slide "# Summary" at the end and moves it to position 2
    Then the deck has 6 slides and slide 2 is "# Summary"

  Scenario: A bad edit saves nothing
    Given the library has the demo deck "Sorting" in the project "Talks"
    And Claude Code read the deck "Sorting"
    When Claude Code sends two edits where the second breaks the frontmatter
    Then the answer says "Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML"
    And the file is unchanged

  Scenario: A whole deck that is not valid is refused
    Given the library has the demo deck "Sorting" in the project "Talks"
    When Claude Code writes a deck whose first frontmatter is broken
    Then the answer starts with "Nothing was saved. The frontmatter is not valid YAML."
    And the file is unchanged

  Scenario: A file changed on disk after Claude Code read it is not overwritten
    Given the library has the demo deck "Sorting" in the project "Talks"
    And Claude Code read the deck "Sorting"
    When someone saves the file in another editor
    And Claude Code writes the whole deck
    Then the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."
    And the file keeps the other editor's change
    When Claude Code reads the deck again and writes it
    Then the file holds Claude Code's deck

  Scenario: Slide numbers from before a change on disk are refused
    Given the library has the demo deck "Sorting" in the project "Talks"
    And Claude Code read the deck "Sorting"
    When someone adds a slide after the first one in another editor
    And Claude Code replaces slide 3, as it read it
    Then the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."
    And the file keeps the other editor's change
    When Claude Code reads the deck again and replaces what is now slide 4
    Then the other editor's slide and the rest of the deck are kept, with Claude Code's slide in place of the one it meant

  Scenario: A deck Claude Code has not read since the server started is not changed
    Given the library has the demo deck "Sorting" in the project "Talks"
    And Claude Code read the deck "Sorting"
    When Claude Code restarts deyslide-mcp and keeps the conversation
    And someone saves the file in another editor
    And Claude Code writes the whole deck
    Then the answer says "Nothing was saved. Call read_deck first, then make your change."
    When Claude Code sends an edit to slide 1
    Then that answer is the same
    And the file keeps the other editor's change

  Scenario: Claude Code can keep changing a deck it created or wrote
    Given the library has the project "Talks"
    When Claude Code creates the deck "Sorting" in "Talks" and writes it again without reading it
    And Claude Code writes it once more and then edits slide 1
    Then each answer starts with "Saved"
    When someone saves the file in another editor
    And Claude Code writes the whole deck
    Then the answer says "Nothing was saved. The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change."
    And the file keeps the other editor's change

  Scenario: Saving follows a link inside the library and keeps the file's permissions
    Given the project "Talks" has a deck "Intro" that links to "Shared/Intro.md", a file only its owner can read
    When Claude Code reads the deck "Intro" and writes it
    Then "Talks/Intro.md" is still a link and "Shared/Intro.md" holds Claude Code's deck
    And only its owner can still read "Shared/Intro.md"

  Scenario: A read-only deck is left alone
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the file "Talks/Sorting.md" is read-only
    When Claude Code reads the deck "Sorting" and writes it
    Then the answer says "Nothing was saved. The deck file is read-only. Make it writable first."
    And the file is unchanged

  Scenario: Ids that point outside the library are not found
    Given the library has the demo deck "Sorting" in the project "Talks"
    And a Markdown file sits next to the library, outside it
    When Claude Code calls every deck tool with ids made from paths
    Then each answer says "There is no deck with that id in this library. Call list_decks to see the decks."
    And creating a deck in a project id made from a path says "There is no project with that id in this library. Call list_decks, or create_project first."
    And the file outside the library is unchanged

  Scenario: Links cannot reach files outside the library
    Given a Markdown file sits next to the library, outside it
    And the library has a project folder and a deck file that link outside it
    When Claude Code lists the decks
    Then the linked folder and file are not listed

  Scenario Outline: Names that do not work on every system are refused
    When Claude Code creates the project "<name>"
    Then the answer contains "<problem>"
    And the library still has no folders

    Examples:
      | name            | problem                                      |
      | CON             | is a name Windows keeps for itself           |
      | nul.txt         | is a name Windows keeps for itself           |
      | com1            | is a name Windows keeps for itself           |
      | LPT9.md         | is a name Windows keeps for itself           |
      | COM0            | is a name Windows keeps for itself           |
      | lpt0.txt        | is a name Windows keeps for itself           |
      | COM¹            | is a name Windows keeps for itself           |
      | lpt³.md         | is a name Windows keeps for itself           |
      | Week 3: Sorting | A name cannot contain                        |
      | Why?            | A name cannot contain                        |
      | Talks/Recursion | A name cannot contain                        |
      | .hidden         | A name cannot start with a dot               |
      | Talks.          | A name cannot end with a dot                 |
      | 81 letters      | A name can have at most 80 characters        |

  Scenario: A deck named after a Windows device is refused
    Given the library has the project "Talks"
    When Claude Code creates the deck "aux" in "Talks"
    Then the answer says "aux" is a name Windows keeps for itself
    And the folder "Talks" holds no files

  Scenario: A taken name is refused
    Given the library has the project "Talks"
    When Claude Code creates the project "talks"
    Then the answer says there is already a project named "talks"

  Scenario: See slides as images through the app
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the Deyslide app is open and reports that slide 3 overflows
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then it gets two PNG images with each slide's click count
    And slide 3 is reported as overflowing
    And the app was asked, with its token, for slides 1 and 3 of the file at their last click

  Scenario: See a slide before its clicks or at one step
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the Deyslide app is open
    When Claude Code renders slide 2 of "Sorting" before its first click, then slides 2 and 3 at step 2
    Then the app was asked for slide 2 with clicks set to 0, then for slides 2 and 3 with 2

  Scenario: Without slide numbers the first six slides are drawn
    Given the library has a deck "Long" in the project "Talks" with 8 slides
    And the Deyslide app is open
    When Claude Code renders "Long" without naming slides
    Then the app was asked for slides 1 to 6 at their last click
    And the answer ends with "The deck has 8 slides. Ask for the others by number."

  Scenario: No app, no images
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the Deyslide app is not open
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then the answer says "Open the Deyslide app to see slide images. The deck is saved."

  Scenario: An app that quit leaves no images either
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the Deyslide app quit and left its bridge file behind
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then the answer says "Open the Deyslide app to see slide images. The deck is saved."

  Scenario: A bridge file left by an app that quit is never contacted
    Given the library has the demo deck "Sorting" in the project "Talks"
    And the Deyslide app quit and another program now listens on the port its bridge file names
    When Claude Code renders slides 1 and 3 of "Sorting"
    Then the answer says "Open the Deyslide app to see slide images. The deck is saved."
    And the other program received nothing

  Scenario: Slides past the end are refused
    Given the library has the demo deck "Sorting" in the project "Talks"
    When Claude Code renders slide 9 of "Sorting"
    Then the answer says "The deck has 5 slides, so there is no slide 9."

  Scenario: The library comes from the app's settings
    Given the app's settings point to a library folder holding the demo deck "Sorting" in the project "Talks"
    And Claude Code runs deyslide-mcp without a library folder
    When Claude Code lists the decks
    Then it shows the deck "Sorting" in that folder
    When the app's settings point to another, empty library folder
    And Claude Code lists the decks again
    Then it says that library has no projects yet
