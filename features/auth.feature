Feature: Accounts
  As a visitor
  I want to sign up and sign in with email, a magic link, Google or GitHub
  So that my work can be saved to my account

  Background:
    Given the Deyslide API with email sending

  Scenario: Sign up with email and password
    When "ana@example.com" signs up with the password "correct horse"
    Then a "Confirm your Deyslide email" email is sent to "ana@example.com"
    And "ana@example.com" is not signed in yet
    When they open the link in that email
    Then they are signed in as "ana@example.com"

  Scenario: Sign in before confirming the email
    Given "ana@example.com" signed up with the password "correct horse"
    When they sign in with the password "correct horse"
    Then sign in is refused because the email is not confirmed
    And a new "Confirm your Deyslide email" email is sent to "ana@example.com"

  Scenario: Sign in with a password
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    When they sign in with the password "correct horse"
    Then they are signed in as "ana@example.com"

  Scenario: A wrong password is refused
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    When they sign in with the password "wrong horse"
    Then sign in is refused as invalid

  Scenario: Sign in with a magic link
    When "budi@example.com" asks for a magic link
    Then a "Your Deyslide sign in link" email is sent to "budi@example.com"
    When they open the link in that email
    Then they are signed in as "budi@example.com"

  Scenario: Reset a forgotten password
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    When they ask to reset the password
    Then a "Reset your Deyslide password" email is sent to "ana@example.com"
    When they choose the new password "battery staple" from that email
    And they sign in with the password "battery staple"
    Then they are signed in as "ana@example.com"

  Scenario: Sign out
    Given a confirmed account for "ana@example.com" with the password "correct horse"
    And they sign in with the password "correct horse"
    When they sign out
    Then nobody is signed in
