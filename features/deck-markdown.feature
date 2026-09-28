Feature: Deck and Slidev Markdown round trips
  As a person editing in both the canvas and the Markdown view
  I want the deck and its Markdown to convert both ways without losing anything
  So that switching views never changes my slides

  Scenario: A deck survives a round trip through Markdown
    Given a deck with every element type
    When it is converted to Slidev Markdown and back
    Then the result equals the original deck

  Scenario: Positioned elements use Slidev's v-drag syntax
    Given a deck with every element type
    When it is converted to Slidev Markdown
    Then the title is written as a v-drag block at "120,80,600,NaN,0"
    And the 3D scene is written as a DeyslideScene3D tag with bound JSON props
    And plain Slidev reads the Markdown as 2 slides with the notes on slide 1

  Scenario: Code steps become a Slidev Magic Move
    Given a deck with every element type
    When it is converted to Slidev Markdown
    Then the two code steps are written inside a 4 backtick "md magic-move" fence with 3 backtick steps

  Scenario: A single code block with fences inside gets a longer fence
    Given a code element with one step whose code contains a line "```"
    When it is converted to Slidev Markdown and back
    Then it is written with a 4 backtick fence
    And the code is unchanged

  Scenario: Canonical Markdown converts back byte for byte
    Given a deck with every element type
    And it was converted to Slidev Markdown once
    When that Markdown is converted to a deck and back again
    Then the Markdown is unchanged

  Scenario: Markdown the model cannot represent is kept
    Given Slidev Markdown with a custom Vue component and a heading
    When it is converted to a deck and back
    Then the component and the heading are kept as raw blocks, byte for byte

  Scenario: A v-drag block with a JavaScript expression stays raw
    Given a v-drag block whose component binds a variable instead of JSON
    When the Markdown is converted to a deck
    Then the whole v-drag block is kept as one raw element

  Scenario: Hand written Markdown gets stable ids
    Given Slidev Markdown with two slides, no ids, and a v-drag block without data-id
    When it is converted to a deck twice
    Then both conversions give the slides ids "slide-1" and "slide-2"
    And the v-drag element gets the id "slide-1:el:1" both times

  Scenario Outline: Read a v-drag position
    Given the v-drag position "<pos>"
    When the position is read
    Then it is <result>

    Examples:
      | pos               | result                                |
      | 120,80,600,NaN,0  | x 120, y 80, w 600, auto height, 0 deg |
      | 10,20,30,40       | x 10, y 20, w 30, h 40, 0 deg          |
      | 10,20,30          | x 10, y 20, w 30, auto height, 0 deg   |
      | 1,2,3,4,45        | x 1, y 2, w 3, h 4, 45 deg             |
      | a,2,3             | rejected                               |
      | 1,2,-3            | rejected                               |
      | 1,2               | rejected                               |
