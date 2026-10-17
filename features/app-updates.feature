Feature: Updates for the Deyslide app
  As a person who uses the Deyslide app
  I want the app to tell me when a new version is out and get it for me
  So that I keep up with releases without visiting the download page

  Scenario: A newer version is offered
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    When the app starts
    Then it says "Deyslide 0.3.0 is available"
    And it offers to install it
    And the home page has the update settings

  Scenario: The app is up to date
    Given the app on a computer runs version 0.2.0 and the latest release is 0.2.0
    When the app starts
    Then it offers no update
    When they choose "Check for updates" in the settings
    Then the settings say "Deyslide 0.2.0 is up to date."

  Scenario: A check they asked for says when it cannot reach GitHub
    Given the app on a computer runs version 0.2.0 and the updater cannot reach GitHub
    When the app starts
    Then it offers no update
    When they choose "Check for updates" in the settings
    Then the settings say "Deyslide could not check for updates. Check your connection and try again."

  Scenario: Installing saves every open deck, then restarts
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And they typed a slide "Typed before the update" in the deck "Intro" on this device
    When they install the update
    Then the file of the deck "Intro" had the slide "Typed before the update" before the update was installed
    And the app restarts once the update is installed

  Scenario: A slide typed while the update installs is saved before the restart
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And the deck "Intro" is open on this device
    And installing the update takes a while
    When they install the update and type a slide "Typed during the install" while it installs
    And the install finishes
    Then the file of the deck "Intro" has the slide "Typed during the install" when the app restarts

  Scenario: Changes that cannot be saved after the install keep the app open
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And the deck "Intro" is open on this device
    And installing the update takes a while
    When they install the update and type a slide "Typed during the install" while it installs
    And the deck file cannot be written when the install finishes
    And they choose to keep their changes open
    Then the app does not restart
    And it says "Deyslide 0.3.0 is installed. Restart once your changes are saved."
    When the deck file can be written again and they choose "Restart"
    Then the file of the deck "Intro" has the slide "Typed during the install" when the app restarts

  Scenario: An update with a bad signature is refused
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And the update file does not match its signature
    When they install the update
    Then the app keeps its version and says "The update to 0.3.0 could not be verified, so it was not installed. You still have Deyslide 0.2.0."
    And the app does not restart

  Scenario Outline: A signature that cannot be read is refused as well
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And the updater rejects the downloaded file with "<error>"
    When they install the update
    Then the app says "The update to 0.3.0 could not be verified, so it was not installed. You still have Deyslide 0.2.0."
    And the app does not restart

    Examples:
      | error                                                                  |
      | Invalid symbol 33, offset 4.                                           |
      | Invalid input length: 7                                                |
      | Invalid last symbol 66, offset 11.                                     |
      | Invalid padding                                                        |
      | Invalid encoding in minisign data                                      |
      | The signature was created with a different key than the one provided |

  Scenario: A download that fails is not taken for a bad signature
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And the updater rejects the downloaded file with "error sending request for url (https://github.com/bambanggunawanid/deyslide/releases/download/v0.3.0/Deyslide_0.3.0_amd64.AppImage)"
    When they install the update
    Then the app says "The update could not be downloaded. Check your connection and try again."
    And the app does not restart

  Scenario: A build without the update key links to the download page
    Given the app on a computer was built without the update key, runs version 0.2.0, and the latest release is 0.3.0
    When the app starts
    Then it says "Deyslide 0.3.0 is available"
    And its "Open the download page" button opens "https://deyslide.bambanggunawan.id/download" in the browser

  Scenario: Android points to the new APK
    Given the Android app runs 0.2.0 and the latest release is 0.3.0
    When the app starts
    Then it says "Deyslide 0.3.0 is available"
    And its "Download the APK" button opens "https://github.com/bambanggunawanid/deyslide/releases/download/v0.3.0/Deyslide_0.3.0_android.apk" in the browser

  Scenario: The automatic check can be turned off
    Given the app on a computer runs version 0.2.0 and the latest release is 0.3.0
    And they turned off the automatic check in the settings
    When the app starts again and runs for a day
    Then it never looked for updates
    And it offers no update

  Scenario: The app looks again each day
    Given the app on a computer runs version 0.2.0 and the latest release is 0.2.0
    When the app starts
    And the release 0.3.0 comes out and a day passes
    Then it says "Deyslide 0.3.0 is available"

  Scenario: iPhones and iPads get new versions from Apple
    Given the iOS app runs 0.2.0 and the latest release is 0.3.0
    When the app starts
    Then it never looked for updates
    And the home page has no update settings

  Scenario Outline: Versions are compared as semantic versions
    Then "<candidate>" is newer than "<current>": <newer>

    Examples:
      | candidate    | current      | newer |
      | 0.3.0        | 0.2.0        | yes   |
      | v0.10.0      | 0.9.9        | yes   |
      | 0.2.0        | 0.2.0        | no    |
      | 0.2.0        | 0.2.0-beta.1 | yes   |
      | 0.2.0-beta.2 | 0.2.0-beta.1 | yes   |
      | 0.2.0-beta.1 | 0.2.0        | no    |
      | 0.2.0-rc.1   | 0.2.0-beta.9 | yes   |
      | 0.0.42       | 0.1.0        | no    |
