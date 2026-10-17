Feature: Calls into the Deyslide app
  As the web app running inside the Deyslide app
  I want one typed call for each command and event of the app
  So that pages reach decks on disk, the account and the render bridge by their exact names

  Scenario: The website never loads the app's packages
    Given the wrappers for the app are imported
    Then nothing from "@tauri-apps/api" has loaded
    When a page asks for the app info
    Then "@tauri-apps/api/core" has loaded

  Scenario Outline: A wrapper calls its command
    When a page calls <call>
    Then the app gets the command "<command>" with <arguments>
    And the page gets the app's answer

    Examples:
      | call                                                  | command                | arguments                                                                     |
      | libraryInfo()                                         | library_info           | no arguments                                                                  |
      | librarySetRoot("/home/ana/Decks")                     | library_set_root       | {"path":"/home/ana/Decks"}                                                    |
      | libraryList()                                         | library_list           | no arguments                                                                  |
      | libraryCreateProject("Algorithms")                    | library_create_project | {"name":"Algorithms"}                                                         |
      | libraryRenameProject("local-p-1", "Graphs")           | library_rename_project | {"id":"local-p-1","name":"Graphs"}                                            |
      | libraryDeleteProject("local-p-1")                     | library_delete_project | {"id":"local-p-1"}                                                            |
      | libraryCreateDeck("local-p-1", "Sorting", "Slide")    | library_create_deck    | {"projectId":"local-p-1","name":"Sorting","markdown":"Slide"}                 |
      | libraryRenameDeck("local-d-2", "Searching")           | library_rename_deck    | {"id":"local-d-2","name":"Searching"}                                         |
      | libraryDeleteDeck("local-d-2")                        | library_delete_deck    | {"id":"local-d-2"}                                                            |
      | libraryReadDeck("local-d-2")                          | library_read_deck      | {"id":"local-d-2"}                                                            |
      | libraryWriteDeck("local-d-2", "New", "Old")           | library_write_deck     | {"id":"local-d-2","content":"New","expected":"Old"}                           |
      | libraryWriteDeck("local-d-2", "New", null)            | library_write_deck     | {"id":"local-d-2","content":"New","expected":null}                            |
      | renderRespond("r1", one drawn slide)                  | render_respond         | {"id":"r1","slides":[{"png":"iVBO","clicks":2,"overflow":false}]}             |
      | authSignIn()                                          | auth_sign_in           | no arguments                                                                  |
      | authSignOut()                                         | auth_sign_out          | no arguments                                                                  |
      | authAccessToken()                                     | auth_access_token      | no arguments                                                                  |
      | authAccount()                                         | auth_account           | no arguments                                                                  |
      | mcpSetup()                                            | mcp_setup              | no arguments                                                                  |
      | presentOpen("local-p-1", "local-d-2")                 | present_open           | {"projectId":"local-p-1","deckId":"local-d-2"}                                |
      | appInfo()                                             | app_info               | no arguments                                                                  |
      | appRestart()                                          | app_restart            | no arguments                                                                  |

  Scenario: Saving a file sends its bytes as they are
    When a page saves the bytes 37, 80, 68, 70 to "/home/ana/Talks/Sorting slides.pdf"
    Then the app gets the command "save_file" with those bytes as the request body
    And the request names the path in the header "x-deyslide-path" as "%2Fhome%2Fana%2FTalks%2FSorting%20slides.pdf"

  Scenario Outline: A wrapper hears its event
    When a page listens with <wrapper>
    And the app sends "<event>" with <payload>
    Then the page hears <heard>
    When the page stops listening
    Then nothing listens to "<event>" anymore

    Examples:
      | wrapper          | event           | payload                                                                                              | heard       |
      | onLibraryChanged | library-changed | null                                                                                                 | no details  |
      | onDeckChanged    | deck-changed    | {"deckId":"local-d-0123456789abcdef"}                                                                | the payload |
      | onRenderRequest  | render-request  | {"id":"r1","markdown":"Hello","slides":[{"number":1,"clicks":"last"}],"width":1280,"height":720} | the payload |
      | onAccountChanged | account-changed | null                                                                                                 | no details  |
      | onPresentSync    | present-sync    | {"deckId":"local-d-2","message":{"slide":3,"clicks":1}}                                              | the payload |

  Scenario: Only the main window draws slides for Claude Code
    Given a page in the window "main"
    When the page listens with onRenderRequest
    Then the page listens to "render-request" in the window "main" only
    And the app gets the command "render_ready" with {"ready":true}
    When the page stops listening
    Then the app gets the command "render_ready" with {"ready":false}

  Scenario: The presenter window tells the audience window
    Given a page in the window "main"
    When the presenter page sends slide 3 of the deck "local-d-2" to the other windows
    Then the app sends "present-sync" with {"deckId":"local-d-2","message":{"slide":3},"from":"main"}

  Scenario: A window does not hear what it sent itself
    Given the presenter page in the window "main" listens with onPresentSync
    And the audience page in the window "present-local-d-2" listens with onPresentSync
    When the presenter page sends slide 3 of the deck "local-d-2" to the other windows
    Then the audience page hears {"deckId":"local-d-2","message":{"slide":3}}
    And the presenter page hears nothing
