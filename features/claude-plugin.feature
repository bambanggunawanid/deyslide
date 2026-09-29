Feature: Claude Code plugin
  As a person who uses Claude Code
  I want to install Deyslide as a plugin from this repository
  So that Claude Code gets the MCP server and knows how to build good decks

  Scenario: The repository is a plugin marketplace
    Given the marketplace file at ".claude-plugin/marketplace.json"
    Then it lists the plugin "deyslide" from "./plugins/deyslide"
    And the plugin's manifest is named "deyslide"

  Scenario: The plugin connects to Deyslide's MCP server
    Given the plugin's MCP settings
    Then the server "deyslide" is an http server at "https://deyslide.bambanggunawan.id/mcp"
    And that is the MCP address the API serves for that public address

  Scenario: The skill covers every MCP tool
    Given the skill "deyslide"
    Then its frontmatter has a name and a description
    And it names every tool the MCP server offers
    And it follows the writing rules
