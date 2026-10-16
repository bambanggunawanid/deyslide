Feature: Media links for the slide preview
  As a person showing pictures from my project on slides
  I want the preview to load them, although it sends no cookies
  So that slides look the same in the editor, in the strip and in the app

  Scenario: A slide's media gets signed links, kept until they are about to expire
    Given the project file "m1", whose signed links last 15 minutes
    When the page asks for links to "/api/media/m1/file" and "https://example.com/cat.png"
    Then it gets a signed link for "/api/media/m1/file" only, after asking the API once with the session cookie
    When it asks again 13 minutes later
    Then it gets the same link without asking the API
    When it asks again 14 and a half minutes after the first time
    Then it asks the API for a fresh link, since the old one stops working within a minute

  Scenario: Parts of the page asking at the same time share one request
    Given the project file "m1", whose signed links last 15 minutes
    When the slide and two strip pictures ask for "/api/media/m1/file" at the same time
    Then the API is asked once, and all three get the same link

  Scenario: A file the server will not link is left out, and asked for again later
    Given the server has no file "gone"
    When the page asks for a link to "/api/media/gone/file"
    Then it gets no link for "/api/media/gone/file"
    When it asks again 10 seconds later
    Then the API was asked once only
    When it asks again 31 seconds after the first time
    Then the API was asked twice

  Scenario: A server out of reach leaves the file out without failing
    Given the server cannot be reached
    When the page asks for a link to "/api/media/m1/file"
    Then it gets no link for "/api/media/m1/file"

  Scenario: In the app, links come from the app's server with its token
    Given the app on a computer, signed in, using the server "https://deyslide.example"
    And the project file "m1", whose signed links last 15 minutes
    When the page asks for a link to "/api/media/m1/file"
    Then the request went to "https://deyslide.example/api/media/m1" through the app's http plugin, with the app's token
    And the page gets the signed link

  Scenario: The preview waits for the links its slide needs, in every view and in the strip
    Given Ana's deck shows a project image on its first slide, on a wide screen, in the Markdown view
    And the API takes a while to answer
    Then the preview has not been asked to render the slide yet
    When the API answers
    Then the preview renders the slide with a signed link for the image
    When Ana switches to the Design view
    Then the slide on the canvas gets the same link
    When the strip's first slide comes into view
    Then the strip's picture of the slide gets the same link too

  Scenario: Signed links stay with the account that asked for them
    Given the project file "m1", whose signed links last 15 minutes
    And Ana's page has a link for "/api/media/m1/file"
    When Ana signs out and the page asks for that link for a guest
    Then the API is asked again, and the guest gets no link
    When a link asked for on Ana's behalf arrives after someone else signed in
    Then the page does not keep it

  Scenario: The deck page asks for links afresh after signing out
    Given Ana's signed in deck shows a project image
    And Ana's preview has a signed link for the image
    When Ana signs out and opens a deck in this browser that shows the same image
    Then the page asks the API again, and its preview gets no link from Ana's account

  Scenario: A preview waiting for a link when the account changes asks again
    Given the project file "m1", whose signed links last 15 minutes
    And a slide on Ana's page waits for a link to "/api/media/m1/file"
    When Budi signs in on the page before the API answers
    Then the API is asked again, for Budi
    And the slide is rendered with the link Budi got
