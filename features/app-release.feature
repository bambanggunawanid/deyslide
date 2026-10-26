Feature: Releasing the apps
  As the person who releases Deyslide
  I want each release tag to give the apps a version every installer accepts
  So that a release ships all its installers at once or waits as a draft

  Scenario Outline: The tag sets the app version
    When the release workflow reads the version for the tag "<tag>"
    Then the apps are built as version "<version>"
    And Windows gets an MSI installer: <msi>

    Examples:
      | tag            | version       | msi |
      | v1.2.3         | 1.2.3         | yes |
      | v1.2.3-4       | 1.2.3-4       | yes |
      | v1.2.3-beta.1  | 1.2.3-beta.1  | no  |
      | v1.2.3+7       | 1.2.3+7       | yes |
      | v1.2.3+git.abc | 1.2.3+git.abc | no  |
      | v1.2.3-70000   | 1.2.3-70000   | no  |
      | v256.0.0       | 256.0.0       | no  |

  Scenario Outline: A tag that is no version stops the release before any build
    When the release workflow reads the version for the tag "<tag>"
    Then it stops and says "<problem>"

    Examples:
      | tag     | problem                                                      |
      | v1.2    | The version "1.2" is not a semantic version such as 1.2.3.   |
      | v01.2.3 | The version "01.2.3" is not a semantic version such as 1.2.3. |
      | v0.0.0  | The version 0.0.0 cannot be released: Android needs at least 0.0.1. |

  Scenario: A run by hand builds a version Android accepts
    When the release workflow runs by hand as run 42
    Then the apps are built as version "0.0.42"

  Scenario Outline: iOS builds the version without its pre-release
    When the release workflow reads the version for the tag "<tag>"
    Then iOS builds version "<core>"

    Examples:
      | tag            | core  |
      | v1.2.3         | 1.2.3 |
      | v1.2.3-beta.1  | 1.2.3 |
      | v1.2.3+git.abc | 1.2.3 |

  Scenario: The updater key turns updates on in a computer build
    When the release workflow reads the version for the tag "v1.2.3" with the updater key "dW50cnVzdGVkIGNvbW1lbnQ=" and the signing key set
    Then the apps are built as version "1.2.3" with updates from "https://github.com/bambanggunawanid/deyslide/releases/latest/download/latest.json" checked against "dW50cnVzdGVkIGNvbW1lbnQ="
    And the build makes signed update files

  Scenario Outline: Without both halves of the updater key a build has no updates
    When the release workflow reads the version for the tag "v1.2.3" with <keys>
    Then the apps are built as version "1.2.3" with no updates
    And the workflow warns "<warning>"

    Examples:
      | keys                                            | warning                                                                                                                  |
      | no updater key at all                           | nothing                                                                                                                  |
      | the updater key "dW50cnVzdGVkIGNvbW1lbnQ=" only | TAURI_UPDATER_PUBKEY is set but the secret TAURI_SIGNING_PRIVATE_KEY is not, so this build has no updates.               |
      | the signing key only                            | The secret TAURI_SIGNING_PRIVATE_KEY is set but the variable TAURI_UPDATER_PUBKEY is not, so this build has no updates. |

  Scenario: An updater key that is no key stops the release before any build
    When the release workflow reads the version for the tag "v1.2.3" with the updater key "not a key" and the signing key set
    Then it stops and says "TAURI_UPDATER_PUBKEY is not an updater public key."

  Scenario: The release waits as a draft until every installer is attached
    Given the Release workflow
    Then the release is created as a draft
    And only the jobs that write to the release may write to the repository
    And the app jobs keep no credentials in their checkout
    And the publish job attaches what the Windows, macOS, Linux and Android jobs built
    And it publishes the release only when those four builds passed, and the iOS build too when the Apple account is set

  Scenario: The iOS build goes to TestFlight, never into the release
    Given the Release workflow
    Then the iOS job signs its build only when the whole Apple account is in the secrets
    And the publish job requires the iOS build by that same rule
    And the iOS files are named unlike the ones the publish job attaches
    And the iOS job uploads the Xcode project it used as "ios-project"
    And it uploads to TestFlight for a pushed tag only

  Scenario: Computer builds sign their update files and the release lists them
    Given the Release workflow
    Then the Windows, macOS and Linux version steps get the updater key from the variable "TAURI_UPDATER_PUBKEY"
    And their builds get the signing key from the secrets only when updates are on
    And they collect each update file's signature
    And the publish job writes latest.json before it attaches the files

  Scenario: Signing secrets reach the builds as they are
    Given the Release workflow
    Then no secret is written to a file the runner reads back
    And the Android build reads its signing key from variables

  Scenario Outline: A pre-release tag never becomes the latest release
    When the release job drafts the release for the tag "<tag>"
    Then the draft is marked as a pre-release: <prerelease>

    Examples:
      | tag              | prerelease |
      | v1.2.3           | no         |
      | v1.2.3-beta.1    | yes        |
      | v1.2.3-4         | yes        |
      | v1.2.3+build-7   | no         |

  Scenario: latest.json lists a signed file for each computer
    Given the files the computer builds made for "v0.3.0", each with its signature
    When the publish job writes latest.json with the notes "Faster canvas"
    Then latest.json says version "0.3.0" with the notes "Faster canvas" and the publish date
    And it lists these files
      | platform           | file                                |
      | windows-x86_64     | Deyslide_0.3.0_x64-setup.exe        |
      | windows-x86_64-msi | Deyslide_0.3.0_x64_en-US.msi        |
      | darwin-aarch64     | Deyslide_0.3.0_universal.app.tar.gz |
      | darwin-x86_64      | Deyslide_0.3.0_universal.app.tar.gz |
      | linux-x86_64       | Deyslide_0.3.0_amd64.AppImage       |
      | linux-x86_64-deb   | Deyslide_0.3.0_amd64.deb            |
    And each one carries the text of its file's signature and the file's link in the release

  Scenario: A file without a signature is left out of latest.json
    Given the files the computer builds made for "v0.3.0", each with its signature
    But the .deb has no signature
    When the publish job writes latest.json with the notes "Faster canvas"
    Then latest.json has no "linux-x86_64-deb"
    And it still lists "linux-x86_64"

  Scenario: A release without signed files has no latest.json
    Given the files the computer builds made for "v0.3.0", without signatures
    When the publish job writes latest.json with the notes "Faster canvas"
    Then no latest.json is written
    And the job says "No update file is signed, so this release has no latest.json."

  Scenario: The Xcode project gets the app's link scheme and settings
    Given an Info.plist from Tauri's iOS template with a link scheme of another app
    When the iOS job applies the app's settings twice
    Then the Info.plist lists the link schemes "com.example.other" and "id.bambanggunawan.deyslide", each once
    And the app is named "Deyslide" under its icon
    And it says it uses no encryption of its own
    And an iPad shows it in every orientation

  Scenario: Scripts keep Unix line endings on Windows runners
    Given a checkout that turns line endings into Windows ones, as Git for Windows does by default
    Then the version script still has Unix line endings

  Scenario: Each computer build checks the MCP server before it is uploaded
    Given the Release workflow
    Then the Windows, macOS and Linux jobs start the executable they built as "deyslide mcp"
    And they do it before collecting the installers

  Scenario: The MCP check passes a working server
    Given an executable that runs the on-device MCP server as "deyslide mcp"
    When the release workflow checks it
    Then the check passes after it lists the tools and writes a deck to the library folder

  Scenario: The MCP check stops a build whose server does not answer
    Given an executable that stops as soon as it starts
    When the release workflow checks it
    Then the check fails and says "The server stopped before the check finished"
