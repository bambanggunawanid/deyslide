Feature: Exporting decks to PDF and video
  As a signed in person
  I want the server to export a deck to a PDF or a video
  So that I can share a talk with people who do not use Deyslide

  Background:
    Given the Deyslide API with a slide renderer and media storage
    And Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"

  Scenario: A PDF is drawn in batches and its progress follows them
    Given the renderer holds each export batch until it is let through
    When Ana exports "Sorting" to PDF
    Then Ana's export is running at 0 percent
    And its file cannot be downloaded yet
    When the renderer lets the first batch through
    Then Ana's export is running at 75 percent
    And the file on disk already holds the first 6 slide images
    When the renderer lets the second batch through
    Then Ana's export is done at 100 percent
    And the renderer drew slides 1 to 6, then 7 and 8, at 1920 by 1080 and their last click

  Scenario: Download a PDF named after the deck
    Given the deck is renamed "Sorting / Searching"
    When Ana exports "Sorting" to PDF and it is done
    And Ana downloads the export
    Then Ana gets "Sorting - Searching.pdf" as "application/pdf"
    And the PDF has 8 pages of 960 by 540 points, each showing its slide's image

  Scenario: A long title keeps whole characters in the file name
    When Ana exports a 2 slide Markdown deck titled with 99 letters and an emoji, and it is done
    And Ana downloads the export
    Then Ana gets the title, emoji included, as the PDF's name

  Scenario: A PDF with every click step
    Given slide 2 of "Sorting" has 2 clicks
    When Ana exports "Sorting" to PDF with every click step and it is done
    Then the renderer drew every slide at click 0, then slide 2 at clicks 1 and 2
    And the downloaded PDF has 10 pages, slide 2's steps in order

  Scenario: Slide images the renderer sends in other kinds of PNG still make pages
    Given the renderer sends its slide images as PNGs with transparency
    When Ana exports "Sorting" to PDF and it is done
    Then the downloaded PDF has 8 pages

  Scenario: The API asks the renderer for a video with every click step and each slide's own time
    Given slide 3 of "Sorting" asks for 2 seconds on screen
    And slide 4 of "Sorting" asks for 0.0004 seconds on screen
    When Ana exports "Sorting" to video with 600 ms per step and it is done
    Then the renderer was asked to record the 8 slides with every click step
    And each slide stays 600 ms on screen at each step, slide 3 2000 ms and slide 4 the shortest time, 500 ms
    And Ana downloads "Sorting.webm" as "video/webm" with the renderer's video in it

  Scenario: A video can show only the last step of each slide
    When Ana exports "Sorting" to video with the last click step of each slide and it is done
    Then the renderer was asked to record the 8 slides at their last click step

  Scenario Outline: An export request is checked before it starts
    When Ana asks for an export with <request>
    Then the export is refused with 400 and "<message>"

    Examples:
      | request                       | message                                                       |
      | a dwell time of 100 ms        | dwellMs must be a whole number of milliseconds from 500 to 60000 |
      | a dwell time of 60001 ms      | dwellMs must be a whole number of milliseconds from 500 to 60000 |
      | both a deck and Markdown      | Send either a deckId or the markdown                          |
      | neither a deck nor Markdown   | Send either a deckId or the markdown                          |
      | the format "gif"              | Choose the format pdf or webm                                 |

  Scenario: Slides keep their project images
    Given Ana uploaded "diagram.png" to "Talks" and slide 7 of "Sorting" shows it
    And Ana uploaded "photo.png" to "Talks" and slide 2 of "Sorting" uses it as its layout's image
    When Ana exports "Sorting" to PDF and it is done
    Then the renderer got "photo.png" as a data URL with the batch that holds slide 2, and "diagram.png" with the one that holds slide 7

  Scenario: Media the person may not open stays out of the export
    Given Budi has an account
    And Budi uploaded "secret.png" to the project "Private"
    And slide 7 of "Sorting" links to "secret.png"
    When Ana exports "Sorting" to PDF and it is done
    Then the renderer got no media

  Scenario: An export carries at most 20 MB of media
    Given Ana uploaded a 21 MB "poster.png" to "Talks" and slide 7 of "Sorting" shows it
    When Ana exports "Sorting" to PDF
    Then Ana's export fails with "The slides use more than 20 MB of media, which is more than an export can hold. Use smaller files."

  Scenario: A slide that cannot be drawn fails the export with the reason
    Given slide 4 of "Sorting" does not compile in the renderer
    When Ana exports "Sorting" to PDF
    Then Ana's export fails with "Slide 4 could not be drawn: Unexpected token. Fix it, then export again."
    And downloading it says "The export failed, so there is no file. Slide 4 could not be drawn: Unexpected token. Fix it, then export again."

  Scenario: An export waits while Claude Code's renders keep the renderer busy
    Given the renderer is busy for the second export batch, once
    When Ana exports "Sorting" to PDF and it is done
    Then the renderer drew slides 1 to 6, then 7 and 8 after one busy answer

  Scenario: A renderer that stays busy fails the export after two minutes
    Given the server's clock is paused
    And the renderer is busy for every export batch
    When Ana exports "Sorting" to PDF
    And 2 minutes pass
    Then Ana's export fails with "The slide renderer is busy with other work. Try again in a few minutes."

  Scenario: A request the renderer refuses says why
    Given the renderer refuses export batches with "Too large"
    When Ana exports "Sorting" to PDF
    Then Ana's export fails with "The slide renderer refused this export: Too large."

  Scenario: Each account runs one export at a time, and the server two
    Given the renderer holds each export batch until it is let through
    And Budi and Citra have accounts
    When Ana exports "Sorting" to PDF twice, then Budi and Citra export a Markdown deck each
    Then Ana's first export and Budi's run, while Ana's second and Citra's are queued
    When the renderer lets every batch through
    Then all four exports are done

  Scenario: The server records one video at a time
    Given the renderer holds each recording until it is let through
    And Budi has an account
    When Ana exports "Sorting" to video, then Budi exports a Markdown deck to video
    Then Ana's video records while Budi's is queued
    When the renderer lets the recordings through
    Then both videos are done

  Scenario: Video export needs a renderer that records
    Given the Deyslide API with a slide renderer that cannot record
    And Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"
    When Ana exports "Sorting" to video
    Then the export is refused with 503 and "Video export is not available on this server."

  Scenario: An account has at most 3 exports under way
    Given the renderer holds each export batch until it is let through
    When Ana exports "Sorting" to PDF 4 times
    Then the fourth export is refused with 429 and "You have 3 exports under way. Wait for one to finish, then try again."

  Scenario: An account keeps its 3 newest finished exports
    When Ana exports "Sorting" to PDF 4 times, one after another
    Then Ana's first export and its file are gone
    And Ana can still download the other three

  Scenario: Claude Code's slide images fit between export batches
    Given Claude Code is connected as Ana
    And the renderer holds each export batch until it is let through
    And Ana is exporting "Sorting" to PDF
    When Claude Code asks for images of slides 1 and 2 of "Sorting"
    And the renderer lets one batch through
    Then Claude Code gets both images while the export is still running
    And the renderer drew Claude Code's slides between the two export batches

  Scenario: Anyone who can open a deck may export it
    Given Budi has an account
    And Ana shared the deck "Sorting" with Budi as a viewer
    When Budi exports "Sorting" to PDF and it is done
    Then Budi downloads "Sorting.pdf"

  Scenario: An export goes when its deck can no longer be opened
    Given Budi has an account
    And Ana shared the deck "Sorting" with Budi as a viewer
    And Budi exported "Sorting" to PDF and it is done
    When Ana deletes "Sorting"
    Then Budi can neither see the export nor download it
    And its file is gone

  Scenario: An export that waited in line checks the deck can still be opened
    Given the renderer holds each export batch until it is let through
    And Budi and Citra have accounts
    And Ana shared the deck "Sorting" with Budi as a viewer
    When Ana and Citra export a Markdown deck each, then Budi exports "Sorting" to PDF
    And Ana deletes "Sorting"
    And the renderer lets every batch through
    Then the renderer never drew "Sorting"
    And Budi can neither see the export nor download it

  Scenario: Strangers can neither export a deck nor see someone's export
    Given Ana exported "Sorting" to PDF and it is done
    And Citra has an account
    When Citra exports "Sorting" to PDF
    Then Citra is told the deck is not found
    And Citra can neither see Ana's export nor download it

  Scenario: Markdown is checked before it is exported
    When Ana exports Markdown whose first frontmatter is broken
    Then the export is refused with 400 and a message starting "The frontmatter is not valid YAML."
    When Ana exports a 2 slide Markdown deck titled "Notes" and it is done
    Then Ana downloads "Notes.pdf" with 2 pages

  Scenario: An export holds at most 100 slides
    When Ana exports Markdown with 101 slides to PDF
    Then the export is refused with 400 and "The deck has 101 slides. An export can have at most 100."

  Scenario: A video is at most 10 minutes long
    When Ana exports Markdown with 20 slides to video with 30000 ms per step
    Then the export is refused with 400 and "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."

  Scenario: A video's click steps count toward its 10 minutes in the renderer
    Given the renderer finds the video too long once it counts the click steps
    When Ana exports "Sorting" to video
    Then Ana's export fails with "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."

  Scenario: A PDF holds at most 300 pages, and finds out before drawing click steps
    Given slide 2 of "Sorting" has 400 clicks
    When Ana exports "Sorting" to PDF with every click step
    Then Ana's export fails with "The PDF would have more than 300 pages. Export the last click step of each slide instead."
    And the renderer drew only the first batch

  Scenario: A PDF has a size limit
    Given exports on a server whose PDFs may hold 0.5 MB, with a renderer that draws photos
    When Ana exports a 2 slide Markdown deck to PDF there
    Then that export fails with "The PDF would be larger than 0.5 MB. Use smaller images, or export fewer slides."

  Scenario: The server stops taking exports while their files fill its space
    Given exports on a server that keeps 1 KB of finished files
    When Ana exports a 2 slide Markdown deck to PDF there and it is done
    Then Ana's next export there is refused with "The server has no room for more exports right now. Try again in a few minutes."

  Scenario: A finished export is removed after an hour
    Given the server's clock is paused
    And Ana exported "Sorting" to PDF and it is done
    When 59 minutes pass
    Then Ana can still download the export
    When one more minute passes
    Then the export and its file are gone

  Scenario: A downloaded export is removed 10 minutes later
    Given the server's clock is paused
    And Ana exported "Sorting" to PDF and it is done
    When Ana downloads the export
    And 9 minutes pass
    Then Ana can still download the export
    When one more minute passes
    Then the export and its file are gone

  Scenario: Shutting down stops exports and removes their files
    Given exports on a server whose renderer holds each batch
    And Ana is exporting a 2 slide Markdown deck there
    When that server shuts down
    Then the renderer is told to stop
    And the export's folder is gone

  Scenario: Folders that earlier runs left behind are removed
    Given an export folder left by a process that has ended
    And one left by an earlier start of this process
    And one that a running process still uses
    When Ana exports "Sorting" to PDF and it is done
    Then the first two folders are gone, and the third is kept

  Scenario: Without a slide renderer, export is unavailable
    Given the Deyslide API without a slide renderer
    And Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"
    When Ana exports "Sorting" to PDF
    Then the export is refused with 503 and "Export is not available on this server."
    And the API's settings say export is off
