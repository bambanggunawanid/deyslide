Feature: Signing in on the web app
  As a visitor
  I want clear sign up and sign in pages
  So that I can create an account the way I prefer

  Scenario: A guest is invited to sign up
    Given a guest opens the web app
    Then the header has a "Sign in" link
    And the banner has a "Sign up" link

  Scenario: Only configured sign in options are shown
    Given a server that offers email and GitHub but not Google
    When a guest opens "/sign-in"
    Then they see "Continue with GitHub" and the email form
    But they do not see "Continue with Google"

  Scenario: Sign in with a password
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    And a guest opens "/sign-in"
    When they sign in as "ana@example.com" with the password "correct horse"
    Then they are on the home page
    And the header shows the account menu for "ana"

  Scenario: A wrong password shows a message
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    And a guest opens "/sign-in"
    When they sign in as "ana@example.com" with the password "wrong horse"
    Then the form says "The email or password is wrong."

  Scenario: Ask for a magic link
    Given a guest opens "/sign-in"
    When they ask for a sign in link for "budi@example.com"
    Then the page says to check "budi@example.com"

  Scenario: Sign up asks to confirm the email
    Given a guest opens "/sign-up"
    When they sign up as "Citra" with "citra@example.com" and the password "correct horse"
    Then the page says to check "citra@example.com"

  Scenario: Sign out
    Given "ana@example.com" is signed in
    When they sign out from the account menu
    Then the header has a "Sign in" link

  Scenario: A signed in person skips the sign in page
    Given "ana@example.com" is signed in
    When they open "/sign-in"
    Then they are on the home page
