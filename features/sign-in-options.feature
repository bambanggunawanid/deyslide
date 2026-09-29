Feature: Sign in options
  As the operator of a Deyslide server
  I want only the sign in options that have credentials to be offered
  So that visitors never see a button that fails

  Scenario Outline: The API reports what is configured
    Given the Deyslide API with <email> and <oauth>
    When the web app asks which sign in options exist
    Then email is <email offered>, Google is <google offered> and GitHub is <github offered>

    Examples:
      | email            | oauth                    | email offered | google offered | github offered |
      | email sending    | no OAuth apps            | on            | off            | off            |
      | no email sending | a Google OAuth app       | off           | on             | off            |
      | email sending    | Google and GitHub apps   | on            | on             | on             |

  Scenario: Without email sending, password sign up is off
    Given the Deyslide API with no email sending and no OAuth apps
    When "ana@example.com" signs up with the password "correct horse"
    Then sign up is refused

  Scenario: Production needs a real secret
    When the server starts in production without BETTER_AUTH_SECRET
    Then it stops with "BETTER_AUTH_SECRET must be set to at least 32 characters in production"

  Scenario: Emails go through Cloudflare Email Service
    Given a Cloudflare mailer for account "acc123" sending from "noreply@bambanggunawan.id"
    When it sends "Your Deyslide sign in link" to "ana@example.com"
    Then it posts to "https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send" with the API token
    And the body has the sender, the recipient, the subject, a text part and an HTML part

  Scenario: A refused email is reported
    Given a Cloudflare mailer whose API answers with error 10001 "Sender domain not verified"
    When it sends "Your Deyslide sign in link" to "ana@example.com"
    Then sending fails with "Cloudflare Email Service refused the email: 10001 Sender domain not verified"
