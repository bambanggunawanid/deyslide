Feature: Slide splitting on this computer matches Slidev
  As a person who keeps decks as files on this computer
  I want the Deyslide app and Claude Code to split my Markdown into slides exactly like Slidev
  So that a deck reads the same in the app, in the cloud and in Slidev

  Scenario Outline: Tricky decks split the same in Rust and in Slidev
    Given the sample deck with <sample>
    When deyslide-mcp and Slidev's parser split it
    Then both find the same slides, lines, frontmatter, content and speaker notes
    And both report broken frontmatter on the same slides
    And joining the slide texts gives the same Markdown as deck-model's joinSlides

    Examples:
      | sample                           |
      | frontmatter on every slide       |
      | code fences holding --- lines    |
      | HTML comments holding --- lines  |
      | speaker notes                    |
      | Magic Move                       |
      | empty slides                     |
      | a leading empty slide            |
      | Windows line endings             |
      | frontmatter in a yaml code block |
      | four dashes and unclosed fences  |
      | separators with trailing spaces  |
      | broken frontmatter               |
      | an unclosed HTML comment         |
      | the demo deck                    |

  Scenario: Joining slides with an empty first slide matches deck-model
    Given the slide texts of a deck whose first slide is empty
    When deyslide-mcp and deck-model's joinSlides join them
    Then both give the same Markdown
    And splitting that Markdown leaves out the empty first slide in both, as Slidev does

  Scenario Outline: Frontmatter YAML is accepted or refused like Slidev
    Given frontmatter with <shape>
    When deyslide-mcp and Slidev's parser read it
    Then deyslide-mcp accepts it exactly when Slidev does
    And where Slidev accepts it, the two read the same values

    Examples:
      | shape                                                  |
      | a tab on an empty line                                 |
      | a comment line indented with a tab                     |
      | a tab on an empty line inside a block scalar           |
      | a tab after the indentation inside a block scalar      |
      | a quoted title that goes on to an unindented line      |
      | a quoted title that goes on to an indented line        |
      | a single quoted title that goes on to an unindented line |
      | a list that goes on to an unindented line              |
      | a list whose closing bracket sits under its key        |
      | a map that goes on to an unindented line               |
      | a nested value that goes on to a line under its key    |
      | a list item that goes on to a line under its dash      |
      | a quoted value that goes on to a line indented by a tab |
      | an escaped quote before the line break                 |
      | a plain value that goes on with a dash and brackets    |
      | a tab line inside a plain value that goes on           |
      | a tab line after a key with no value                   |
      | a tab line before nested values                        |
      | a number too long for 64 bits                          |
      | a bell character                                       |
      | a line separator character                             |
      | a next line character                                  |
      | a carriage return on its own                           |
      | duplicate keys                                         |
      | an anchor and an alias                                 |
      | a custom tag                                           |

  Scenario Outline: A few rare shapes are still read differently
    Given frontmatter with <shape>
    When deyslide-mcp and Slidev's parser read it
    Then deyslide-mcp <rust> it and Slidev <slidev> it

    Examples:
      | shape                                                     | rust    | slidev  |
      | lists nested 200 levels deep                              | refuses | accepts |
      | a key left empty                                          | refuses | accepts |
      | a tab between the indentation and a value under a key with no value | refuses | accepts |
      | the keys 1 and 01                                         | accepts | refuses |
