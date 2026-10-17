Feature: The web app inside the Deyslide app
  As a person who uses Deyslide on the website or in the app
  I want the same pages to reach the server, sign in and save files the way each place allows
  So that the app works like the website without a second copy of every page

  Scenario: The website calls the API on its own origin
    Given the website
    When a page asks the API for "/api/projects"
    Then the browser fetches "/api/projects" with the session cookie
    And the request has no access token

  Scenario: The app calls its server with an access token
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the app is signed in with the access token "token-1"
    When a page asks the API for "/api/projects"
    Then the http plugin fetches "https://deyslide.bambanggunawan.id/api/projects"
    And the request carries "Bearer token-1"

  Scenario: The app calls its server without a token when nobody is signed in
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And nobody is signed in to the app
    When a page asks the API for "/api/config"
    Then the http plugin fetches "https://deyslide.bambanggunawan.id/api/config"
    And the request has no access token

  Scenario: The app sends a whole request to its server
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the app is signed in with the access token "token-1"
    When a page sends a request to "/api/projects" that creates the project "Talks"
    Then the http plugin fetches "https://deyslide.bambanggunawan.id/api/projects"
    And the request is a "POST" of the JSON {"name":"Talks"}
    And the request carries "Bearer token-1"

  Scenario: The app uses the server its settings name
    Given the app on a computer, using the server "http://127.0.0.1:3001/"
    Then API paths start with "http://127.0.0.1:3001"
    And live editing connects to "ws://127.0.0.1:3001/api/collab"

  Scenario: The app falls back to the server it was built for
    Given the app cannot say which server it uses
    Then API paths start with "https://deyslide.bambanggunawan.id"
    And live editing connects to "wss://deyslide.bambanggunawan.id/api/collab"

  Scenario Outline: The app knows the kind of device it runs on
    Given the app says it runs on "<platform>"
    Then it is the app on <device>

    Examples:
      | platform | device            |
      | linux    | a computer        |
      | windows  | a computer        |
      | macos    | a computer        |
      | android  | Android           |
      | ios      | an iPhone or iPad |

  Scenario Outline: An app that cannot say its system goes by the browser engine
    Given the app cannot say which system it runs on, in a browser engine for <engine>
    Then it is the app on <device>

    Examples:
      | engine                   | device            |
      | an iPhone                | an iPhone or iPad |
      | an iPad                  | an iPhone or iPad |
      | a Mac                    | a computer        |
      | an Android phone         | Android           |

  Scenario Outline: Project, sharing and assistant calls go through the app's server
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the app is signed in with the access token "token-1"
    When a page <call>
    Then the http plugin fetches "https://deyslide.bambanggunawan.id<path>"
    And the request carries "Bearer token-1"

    Examples:
      | call                                   | path                     |
      | lists the projects                     | /api/projects            |
      | lists who can open the project "p1"    | /api/projects/p1/sharing |
      | asks whether the assistant is on       | /api/config              |
      | asks how much of the assistant is left | /api/assistant           |

  Scenario: The app frees an answer that has no body
    Given the app's http plugin
    When the server answers a request with "204 No Content"
    Then the plugin frees that answer in the app at once

  Scenario: Live editing on the website signs in with the session cookie
    Given the website at "https://deyslide.bambanggunawan.id"
    Then live editing connects to "wss://deyslide.bambanggunawan.id/api/collab"
    And live editing signs in with "cookie"

  Scenario: Live editing in the app signs in with an access token
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the app is signed in with the access token "token-1"
    Then live editing signs in with "token-1"

  Scenario: The website downloads a saved file
    Given the website
    When a page saves "Sorting.pdf" of type "application/pdf"
    Then the browser downloads "Sorting.pdf" with those bytes and that type
    And the page hears that the file was saved

  Scenario: The app on a computer asks where to save
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the person picks "/home/ana/Talks/Sorting.pdf" in the save dialog
    When a page saves "Sorting.pdf" of type "application/pdf"
    Then the save dialog suggested "Sorting.pdf" among PDF files
    And the app gets the command "save_file" for "/home/ana/Talks/Sorting.pdf" with those bytes
    And the page hears that the file was saved

  Scenario: The app on Android writes to the document the person picked
    Given the app on Android
    And the person picks "content://com.android.externalstorage.documents/document/primary%3ADownload%2FSorting.pdf" in the save dialog
    When a page saves "Sorting.pdf" of type "application/pdf"
    Then the save dialog suggested "Sorting.pdf" among files of type "application/pdf"
    And the fs plugin writes those bytes to "content://com.android.externalstorage.documents/document/primary%3ADownload%2FSorting.pdf"
    And the app gets no "save_file" command
    And the page hears that the file was saved

  Scenario: The app on an iPhone or iPad writes to the place the person picked
    Given the app on iOS
    And the person picks "file:///private/var/mobile/Containers/Shared/AppGroup/Files/Sorting.pdf" in the save dialog
    When a page saves "Sorting.pdf" of type "application/pdf"
    Then the save dialog suggested "Sorting.pdf" with no filters
    And the fs plugin writes those bytes to "file:///private/var/mobile/Containers/Shared/AppGroup/Files/Sorting.pdf"
    And the app gets no "save_file" command
    And the page hears that the file was saved

  Scenario: The app on an iPhone or iPad presents in its one window
    Given the app on iOS
    When a deck's presenter view starts
    Then it has no audience window to open
    And no window counts as the deck's audience window

  Scenario Outline: Only the app on a computer connects Claude Code
    Given the app says it runs on "<platform>"
    When they open "/"
    Then the page shows "Your projects"
    And the "Connect Claude Code" panel is <shown>

    Examples:
      | platform | shown     |
      | linux    | shown     |
      | android  | not there |
      | ios      | not there |

  Scenario: Cancelling the save dialog saves nothing
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    And the person cancels the save dialog
    When a page saves "Sorting.pdf" of type "application/pdf"
    Then nothing is written
    And the page hears that the file was not saved

  Scenario Outline: Links leave for the browser
    Given <where>
    When a page opens "https://github.com/bambanggunawanid/deyslide" outside Deyslide
    Then <what opens it>

    Examples:
      | where                                                                        | what opens it              |
      | the website                                                                  | a new browser tab opens it |
      | the app on a computer, using the server "https://deyslide.bambanggunawan.id" | the opener plugin opens it |

  Scenario: The app starts on its home page
    Given the app on a computer, signed out
    When the app's pages start
    Then the page shows "Your projects"
    And the page address ends in "#/"
    And no Better Auth client was created

  Scenario: A sign in that finishes while the app starts is shown
    Given the app on Android, signed out
    And the browser hands a sign in as "Ana" back to the app right after the page first asks for the account
    When the app's pages start
    Then the header shows the account menu for "Ana"

  Scenario Outline: The address keeps the page in a way each place can reload
    Given <where>
    Then the address of the project "p1" is "<address>"

    Examples:
      | where                             | address |
      | the website                       | /p/p1   |
      | the app on a computer, signed out | #/p/p1  |

  Scenario: The app never creates the Better Auth client
    Given the app on a computer, using the server "https://deyslide.bambanggunawan.id"
    When the page starts its account service
    Then it is the app's account service
    And no Better Auth client was created

  Scenario: The website signs in with Better Auth
    Given the website
    When the page starts its account service
    Then it is the Better Auth account service
    And one Better Auth client was created

  Scenario: The app's sign in page offers only the browser
    Given the app on a computer, signed out
    When they open "/sign-in"
    Then the page offers only "Sign in with your browser"

  Scenario: Signing in on a computer
    Given the app on a computer, signed out
    And they open "/sign-in"
    When they choose "Sign in with your browser" and sign in as "Ana" there
    Then the app got the command "auth_sign_in"
    And they are on the home page
    And the header shows the account menu for "Ana"

  Scenario: Signing in on Android finishes when they come back
    Given the app on Android, signed out
    And they open "/sign-in"
    When they choose "Sign in with your browser"
    Then the page asks them to finish in the browser
    When they come back to the app signed in as "Ana"
    Then they are on the home page
    And the header shows the account menu for "Ana"

  Scenario: Signing in on an iPhone finishes when they come back
    Given the app on iOS, signed out
    And they open "/sign-in"
    When they choose "Sign in with your browser"
    Then the page asks them to finish in the browser
    When they come back to the app signed in as "Ana"
    Then they are on the home page
    And the header shows the account menu for "Ana"

  Scenario: On a computer they can start the sign in again
    Given the app on a computer, signed out
    And they open "/sign-in"
    When they choose "Sign in with your browser" and close the browser tab
    Then the page asks them to finish in the browser
    When they choose "Open the browser again" and sign in as "Ana" there
    Then the app got the command "auth_sign_in" 2 times
    And they are on the home page

  Scenario: A sign in on Android that does not finish says so
    Given the app on Android, signed out
    And they open "/sign-in"
    When they choose "Sign in with your browser"
    And they come back to the app without signing in
    Then the page says "Signing in did not finish. Try again."
    And the button reads "Sign in with your browser" again

  Scenario: Signing out in the app
    Given the app on a computer, signed in as "Ana"
    When they sign out from the account menu
    Then the app got the command "auth_sign_out"
    And the header has a "Sign in" link

  Scenario: Signing out in the app deletes the account's decks kept on the device
    Given the app on a computer, signed in as "Ana", with the deck "Intro" kept on the device
    When they sign out from the account menu
    Then the header has a "Sign in" link
    And nothing of Ana's account is left on the device

  Scenario: The app signs them out when the server ends the sign in
    Given the app on a computer, signed in as "Ana"
    When the app says the account changed and nobody is signed in anymore
    Then the header has a "Sign in" link

  Scenario: A sign in that finishes while a deck is open keeps what was typed
    Given the app on a computer, signed out, with the deck "Intro" in the project "Talks" on this device
    And they open the deck "Intro" and type a slide "Typed while signing in"
    When the browser sign in as "Ana" finishes before the deck saves
    Then they are on the home page
    And the file of the deck "Intro" has the slide "Typed while signing in"
    And Ana's account has no deck "Intro"

  Scenario: Signing out from an open deck saves what was typed first
    Given the app on a computer, signed in as "Ana", with the deck "Intro" in the project "Talks"
    And they open the deck "Intro" and type a slide "Typed before signing out"
    When they sign out from the account menu before the deck saves
    Then the header has a "Sign in" link
    And the deck "Intro" in Ana's account has the slide "Typed before signing out"

  Scenario: The app starts without waiting long for a server that does not answer
    Given the app on a computer, signed in as "Ana", with a server that does not answer
    When they open "/"
    Then the page shows "Your projects"
    And the header has a "Sign in" link

  Scenario: The app shows the account once its server answers again
    Given the app on a computer, signed in as "Ana", with a server it cannot reach
    And they open "/"
    And the header has a "Sign in" link
    When the server answers again and they come back to the window
    Then the header shows the account menu for "Ana"

  Scenario: Without an answer from its server the app keeps the account it shows
    Given the app on a computer, signed in as "Ana"
    When the server cannot be reached and the app says the account changed
    Then the header shows the account menu for "Ana"

  Scenario Outline: The header offers the app on the website only
    Given <where>
    When they open "/"
    Then the header <shows> the "Get the app" and "Watch the demo" links

    Examples:
      | where                             | shows         |
      | the website                       | has           |
      | the app on a computer, signed out | does not have |

  Scenario Outline: The guest banner says where work is kept
    Given <where>
    When they open "/"
    Then the banner says the work is saved <kept> only
    And its "<button>" button leads to "<link>"

    Examples:
      | where                             | kept            | button  | link     |
      | the website                       | in this browser | Sign up | /sign-up |
      | the app on a computer, signed out | on this device  | Sign in | /sign-in |

  Scenario Outline: The download page links the latest release's files
    Given GitHub lists the release "v0.2.0" with the files the release workflow makes
    When they open "/download"
    Then the "<button>" link leads to "<file>"
    And the page says "Latest version: v0.2.0"

    Examples:
      | button               | file                          |
      | download-windows     | Deyslide_0.2.0_x64-setup.exe  |
      | download-windows-msi | Deyslide_0.2.0_x64_en-US.msi  |
      | download-macos       | Deyslide_0.2.0_universal.dmg  |
      | download-linux       | Deyslide_0.2.0_amd64.AppImage |
      | download-linux-deb   | Deyslide_0.2.0_amd64.deb      |
      | download-android     | Deyslide_0.2.0_android.apk    |

  Scenario: The download page skips an APK without a signature
    Given GitHub lists the release "v0.2.0" with "Deyslide_0.2.0_android-unsigned.apk" before "Deyslide_0.2.0_android.apk"
    When they open "/download"
    Then the "download-android" link leads to "Deyslide_0.2.0_android.apk"

  Scenario: Without GitHub the buttons lead to the releases page
    Given GitHub cannot be reached
    When they open "/download"
    Then the Windows, macOS, Linux and Android buttons lead to "https://github.com/bambanggunawanid/deyslide/releases"
    And there are no other download links

  Scenario: The download page explains the first start on a Mac and Claude Code
    Given the website at "https://deyslide.bambanggunawan.id"
    When they open "/download"
    Then the page explains "Open Anyway" in "Privacy & Security"
    And it shows the command the app gives for Claude Code on this computer
    And it shows the command "claude mcp add --scope user --transport http deyslide https://deyslide.bambanggunawan.id/mcp"
