Feature: Video export options
  As a presenter exporting a talk to video
  I want clear defaults and strict flag checks
  So that a long recording does not fail halfway because of a typo

  Scenario: Defaults give a 1080p WebM
    When I run the export with no flags
    Then the video is 1920 by 1080
    And it is saved to "exports/deyslide.webm"
    And each step stays on screen for 3000 ms

  Scenario: Flags override the defaults
    When I run the export with "--width=1280 --height 720 --dwell 5000 --output exports/talk.webm"
    Then the video is 1280 by 720
    And it is saved to "exports/talk.webm"
    And each step stays on screen for 5000 ms

  Scenario Outline: Invalid flags stop the export
    When I run the export with "<flags>"
    Then the export stops with "<message>"

    Examples:
      | flags                   | message                  |
      | --width 0               | positive whole number    |
      | --dwell fast            | positive whole number    |
      | --output talk.mp4       | must end with .webm      |
      | --fps 60                | Unknown option           |
      | --output                | needs a value            |

  Scenario Outline: A slide can ask for more screen time
    Given a slide with frontmatter videoDwell <seconds>
    When the dwell time is computed with a default of 3000 ms
    Then the slide stays on screen for <ms> ms

    Examples:
      | seconds | ms    |
      | 12      | 12000 |
      | 1.5     | 1500  |
      | 0       | 3000  |
      | none    | 3000  |
