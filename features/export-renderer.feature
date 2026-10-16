Feature: The slide renderer draws and records exports
  As the Deyslide API exporting a deck
  I want the renderer to draw slides at the size I ask for and to record videos on a line of their own
  So that exports are sharp and Claude Code's slide images never wait behind a recording

  Scenario: Slides are drawn at the size a request asks for
    Given the renderer's API in front of a drawer double
    When the API asks it for 2 slides at 1920 by 1080 with a media link
    Then the drawer draws both at 1920 by 1080 with that media link
    When the API asks it for a slide without a size
    Then the drawer draws it at 1280 by 720

  Scenario Outline: A size out of range is refused
    Given the renderer's API in front of a drawer double
    When a request asks for slides <width> by <height>
    Then it is refused with 400 and "<message>"

    Examples:
      | width  | height | message                                             |
      | 5000   | 1080   | The width must be a whole number from 320 to 3840   |
      | 1920.5 | 1080   | The width must be a whole number from 320 to 3840   |
      | 1920   | 100    | The height must be a whole number from 180 to 2160  |

  Scenario: The host page frames slides at the size asked for
    Given the renderer's site is served
    When its host page is opened for 1920 by 1080
    Then its preview frame is 1920 by 1080
    When its host page is opened for 99999 by 1080
    Then its preview frame is 1280 by 720

  Scenario: Each media file goes to the host page once, and each slide gets only its own
    Given a host page with three media files
    When a slide that shows the first file is drawn at two click steps
    And a slide that shows the first file and uses the second as its layout's image is drawn
    And a slide without media is drawn
    Then the first file went to the page once, then the second
    And each render named only the links its slide uses
    And the third file never went to the page

  Scenario: A video comes with its progress, then the WebM
    Given the renderer's API in front of a drawer double
    When the API asks it for a video of 3 slides
    Then the drawer records the 3 slides in order, each with its time on screen
    And the API hears progress 0.5, then 1
    And the API saves the drawer's WebM byte for byte
    And the drawer's recording is removed once it is sent

  Scenario: A video that cannot be recorded says why
    Given the renderer's API in front of a drawer double that cannot draw slide 2
    When the API asks it for a video of 3 slides
    Then the API is told "Slide 2 could not be drawn: Unexpected token"
    And no video file is left behind

  Scenario: A video request that is not valid is refused
    Given the renderer's API in front of a drawer double
    When the API asks it for a video whose slide stays 11 minutes on screen
    Then the API is told the renderer refused it with "Send 1 to 100 slides, each with a dwell time of at most 600000 ms"
    And the drawer recorded nothing

  Scenario: A busy renderer refuses a video before it starts
    Given the renderer's API in front of a drawer double that is busy
    When the API asks it for a video of 3 slides
    Then the API is told the renderer is busy
    And no video file is left behind

  Scenario: A busy renderer refuses slides, and the API can tell
    Given the renderer's API in front of a drawer double that is busy drawing
    When the API asks it for 2 slides at 1920 by 1080 with a media link
    Then the API is told the renderer is busy

  Scenario: The recording stops when the API gives up
    Given the renderer's API in front of a drawer double whose recording never ends
    When the API asks it for a video and gives up after a moment
    Then the API is told the renderer took too long
    And the drawer is asked to stop recording

  Scenario: Videos record one at a time on a line of their own
    Given a slide drawer whose recordings wait until they are let through
    When two videos are asked for
    Then the first records and the second is refused as busy
    And slides are still drawn while the first video records
    When the recording is let through
    Then the first video is recorded
    And another video can record now

  Scenario: A video counts click steps first, then lets each slide settle and holds every step
    Given a slide drawer with pages that stand in for Chromium
    When it records slide 1 with no clicks for 600 ms a step and slide 2 with 2 clicks for 800 ms a step
    Then it first drew each slide at click 0 on a page that does not record, without media
    And then it recorded at 1920 by 1080 with the deck's media
    And slide 1 came in, settled and stayed 600 ms
    And slide 2 came in with its transition, settled and stayed 800 ms, then stayed 800 ms at click 1 and at click 2
    And its progress rose to 1 with the planned time
    And both pages were closed and the video was kept

  Scenario: A video that click steps make too long is refused before it records
    Given a slide drawer with pages that stand in for Chromium
    When it records 3 slides of 3 seconds a step, the first with 100000 clicks
    Then it is told "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."
    And it stopped counting after the first slide
    And no recording page was opened

  Scenario: A slide that cannot be drawn stops the video before it records
    Given a slide drawer with pages that stand in for Chromium
    When it records 3 slides and slide 2 does not compile
    Then it is told "Slide 2 could not be drawn: Unexpected token"
    And no recording page was opened

  Scenario: A recording that falls behind stops as soon as it would run long
    Given a slide drawer with pages that stand in for Chromium, each render taking 3 seconds
    When it records the last step of 19 slides for 30 seconds each
    Then it is told "The slides took too long to draw for a video of at most 10 minutes. Show each slide for less time, or export fewer slides."
    And it stopped before the last slide, within 10 and a half minutes
    And the recording page was closed and nothing was kept

  Scenario: A recording stops when it is asked to
    Given a slide drawer with pages that stand in for Chromium
    When it records 3 slides and is asked to stop during the first
    Then it is told "The recording was stopped."
    And the recording page was closed and nothing was kept

  Scenario: The API and the renderer measure a video the same way
    Given slides with their dwell times and click steps
    Then the API's video length and the renderer's agree
    And a slide's steps add their dwell plus the time to draw them, after the slide settles

  Scenario: The web app, the API and the renderer ask for a slide's last step with one number
    Then the click number for "the last step" is the same everywhere
