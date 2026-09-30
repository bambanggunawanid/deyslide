Feature: Deploy release folders
  As the person who runs Deyslide
  I want every folder the release packs to reach the server
  So that each part of production runs the code that was just built

  Scenario: Every packed folder is moved into place
    Given the Deploy workflow
    Then the release packs the folders "site", "server" and "renderer"
    And starting the containers moves each of those folders into place
    And the folders they replace are removed after the containers start
