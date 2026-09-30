Feature: Deploy settings
  As the person who runs Deyslide
  I want the Deploy workflow to find each setting where GitHub lets me keep it
  So that production turns on what I configured

  Scenario: The Cloudflare account ID can be a variable or a secret
    Given the Deploy workflow
    Then it reads "CLOUDFLARE_ACCOUNT_ID" from the environment's variables, then its secrets
    And it writes "CLOUDFLARE_ACCOUNT_ID" into the server's settings
