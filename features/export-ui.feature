Feature: Exporting a deck from the editor
  As a person who made a deck
  I want to export it as a PDF or a video from the deck page or the presenter view
  So that people who did not see the talk can still go through it

  Scenario: Guests make the PDF on their own device
    Given the demo deck "Sorting" is open in this browser, signed out
    When I open the Export menu
    Then it offers "PDF (this device)" and "PDF with every click step (this device)" only

  Scenario: Signed in, the server makes PDFs and videos
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana opens the Export menu
    Then it offers "PDF", "PDF with every click step" and "Video (WebM)"

  Scenario: A server without exports leaves the PDF to the device
    Given Ana is signed in with the deck "Graphs" open, on a server that does not make exports
    When Ana opens the Export menu
    Then it offers "PDF (this device)" and "PDF with every click step (this device)" only

  Scenario: A PDF made on the server shows its progress and is saved
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF, and the server says it is waiting, then half done, then done
    Then the page said "The PDF is waiting for its turn..." and then "Making the PDF... 50%"
    And the server was asked for a PDF of the deck by its id, with the last click of each slide
    And the server's file "Graphs.pdf" is saved, and the page says "Saved Graphs.pdf."

  Scenario: A video shows every click step
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a video, which the server names "Graphs.webm"
    Then the server was asked for a WebM video of the deck by its id, with every click step
    And the server's file "Graphs.webm" is saved as a video

  Scenario: A failed export says why, and saves nothing
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF with every click step, and the server says it failed: "Slide 2 shows an error: x is not defined"
    Then the page alerts "The PDF could not be made. Slide 2 shows an error: x is not defined"
    And nothing is saved

  Scenario: An export the server refuses says why
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF, and the server refuses: "You already have 3 exports. Wait until one is done."
    Then the page alerts "You already have 3 exports. Wait until one is done."
    And nothing is saved

  Scenario: A download that does not arrive says so
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF, and the download fails: "The server could not be reached. Check the connection and try again."
    Then the page alerts "The server could not be reached. Check the connection and try again."
    And nothing is saved

  Scenario: When the server cannot be reached, the menu offers the PDF made on this device too
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF, and the server cannot be reached
    Then the page alerts "The server could not be reached. Check the connection and try again."
    When Ana opens the Export menu again
    Then it offers the server's "PDF", "PDF with every click step" and "Video (WebM)", and "PDF (this device)" and "PDF with every click step (this device)"

  Scenario: The menu asks the server again when an earlier check found no exports
    Given Ana is signed in with the deck "Graphs" open, while the server's answer about exports did not come
    When the server answers, and Ana opens the Export menu
    Then it offers "PDF", "PDF with every click step" and "Video (WebM)"

  Scenario: A deck on this device sends its Markdown with typing the deck has not taken yet
    Given Ana is signed in, on a server that makes exports, with a deck on this device open in the Markdown view
    When Ana types a new last slide "Typed just now" and exports a PDF at once
    Then the server was asked for a PDF of the deck's Markdown with the slide "Typed just now", without an id

  Scenario: A deck on this device sends its Markdown to the server
    Given Ana is signed in, with the Export menu of a deck on this device whose id is "local-d-0123456789abcdef"
    When Ana exports a PDF from that menu
    Then the server was asked for a PDF of the deck's Markdown, without an id

  Scenario: A PDF made on the device draws every slide in print mode
    Given the demo deck "Sorting" is open in this browser, signed out
    When I export "PDF (this device)"
    Then the preview drew each of the 5 slides in print mode at its last click, and each was captured at 1.5 times
    And the file "Sorting.pdf" is saved: a PDF of 5 pages, each 960 by 540 points
    And the page says "Saved Sorting.pdf."

  Scenario: A PDF made on the device shows the deck's project images
    Given Ana is signed in, on a server without exports, with a deck whose second slide shows a project image
    When I export "PDF (this device)"
    Then the second slide was drawn with a signed link for the image
    And the file "Pets.pdf" is saved

  Scenario: A PDF made on the device can show every click step
    Given the demo deck "Sorting" is open in this browser, signed out
    When I export "PDF with every click step (this device)"
    Then the preview drew 10 steps: slide 1, slide 2 at clicks 0 to 2, slide 3 at clicks 0 to 3, then slides 4 and 5
    And the file "Sorting.pdf" is saved: a PDF of 10 pages

  Scenario: A slide that cannot be drawn stops the PDF made on the device
    Given the demo deck "Sorting" is open in this browser, signed out, and slide 2 shows the error "x is not defined"
    When I export "PDF (this device)"
    Then the page alerts "Slide 2 could not be drawn: x is not defined"
    And nothing is saved

  Scenario: How an export goes shows on a line of its own, so the buttons stay put
    Given Ana is signed in with the deck "Graphs" open, on a server that makes exports
    When Ana exports a PDF, and the server is a quarter done
    Then the page says "Making the PDF... 25%" on a line of its own under the buttons, which screen readers follow
    And the row of buttons holds no status

  Scenario: The presenter view shows how an export goes under its buttons too
    Given Ana is signed in with the deck "Graphs" open in the presenter view, on a server that makes exports
    When Ana exports a PDF, and the server is a quarter done
    Then the presenter view says "Making the PDF... 25%" on a line of its own under its header, which screen readers follow

  Scenario: The presenter view has the Export menu too
    Given the demo deck "Sorting" is open in the presenter view, signed out
    When I export "PDF (this device)" from the presenter view
    Then the file "Sorting.pdf" is saved: a PDF of 5 pages

  Scenario: The export client follows a job on the server and downloads its file
    Given an export client talking to a server
    When it exports the deck "d1" as a PDF with every click step, follows it until done and downloads it
    Then it sent "POST /api/exports" with the deck id, the format and the clicks, then "GET /api/exports/job-1" and "GET /api/exports/job-1/file"
    And the file is named "Café notes.pdf" from the server's download header

  Scenario: The export client puts the server's problems in words
    Given an export client talking to a server
    Then a refusal reads as the server's own message
    And a server that cannot be reached reads "The server could not be reached. Check the connection and try again."
    And it reads from /api/config whether the server makes exports

  Scenario: The export client asks again after a check that failed, and keeps an answer that came
    Given an export client whose server cannot be reached at first
    When it checks whether the server makes exports
    Then it says no
    When the server can be reached again and it checks twice more
    Then it says yes, and asked /api/config twice in all
