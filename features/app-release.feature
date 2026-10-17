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

  Scenario: The release waits as a draft until every installer is attached
    Given the Release workflow
    Then the release is created as a draft
    And only the jobs that write to the release may write to the repository
    And the app jobs keep no credentials in their checkout
    And the publish job attaches what the Windows, macOS, Linux and Android jobs built
    And it publishes the release only when all four builds passed

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
