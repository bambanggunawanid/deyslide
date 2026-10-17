Feature: Settings that merge key by key
  As two people editing the same deck at once
  I want each setting of a block, and each frontmatter key of a slide, to be stored on its own
  So that changing different settings at the same time keeps both changes

  Background:
    Given Ana and Budi have the same deck open

  Scenario: Two people change different settings of one shape
    When Ana changes a rectangle's fill and Budi changes its stroke at the same time
    And their documents sync
    Then the rectangle has Ana's fill and Budi's stroke for both of them

  Scenario: Two people change different settings of a 3D scene through the canvas and through Markdown
    When Ana changes the 3D scene's zoom in the canvas
    And Claude writes Markdown, read before Ana's change, that moves the 3D scene's camera
    And their documents sync
    Then the 3D scene has Ana's zoom and Claude's camera for both of them

  Scenario: Changing the layout and the transition at the same time keeps both
    When Ana changes the layout of slide "details" and Budi adds a transition to it at the same time
    And their documents sync
    Then slide "details" has Ana's layout and Budi's transition for both of them
    And both write the same Markdown for it

  Scenario: Only the settings that changed are written, and removed ones are deleted
    When the shape "box" is updated with an outline width and without its fill
    Then the change wrote only the outline width and the removal of the fill
    And the shape "box" reads as a rectangle with that outline width and no fill

  Scenario: Frontmatter keeps the order it is written in
    When the frontmatter of "intro" gets a key "class" first and a key "info" after "theme"
    Then the Markdown of "intro" lists class, theme, info, title and layout in that order
    And Budi's copy writes the same Markdown once the documents sync
    When the frontmatter of "intro" is written with layout first
    Then the Markdown of "intro" lists layout, class, theme, info and title in that order

  Scenario: Two people adding frontmatter keys at once write the same Markdown
    When Ana adds the key "class" and Budi adds the key "clicks" to slide "details" at the same time
    And their documents sync
    Then slide "details" has the keys layout, class and clicks for both of them, in the same order

  Scenario: Two people who added keys at once still keep their later changes to different keys
    When Ana adds the key "class" and Budi adds the key "clicks" to slide "details" at the same time
    And their documents sync
    And Ana changes the layout of slide "details" while Budi changes its clicks to 5
    And their documents sync once more
    Then slide "details" has Ana's layout and Budi's clicks for both of them

  Scenario: Moving frontmatter keys at the same time as a change to one of them keeps both
    When Ana changes the layout of slide "intro" in the canvas
    And Claude writes Markdown, read before Ana's change, that lists the layout first and adds a transition
    And their documents sync
    Then slide "intro" has Ana's layout and Claude's transition, with the layout first, for both of them

  Scenario: Moving frontmatter keys writes only their places
    When the frontmatter of "intro" is written with layout first
    Then the change wrote only the order of the keys, and no value

  Scenario: An older deck keeps working
    Given a deck stored before settings were split
    Then it reads as before and writes the same Markdown
    When Ana changes a shape's fill
    Then the deck reads as before with the new fill
    And the shape's settings are now stored one by one, and the frontmatter is still stored as before
    When Ana changes the layout of slide "details"
    Then the frontmatter is stored one key at a time too, and the deck reads as before with the new layout
    When Ana moves slide "intro" after "details"
    Then its frontmatter and its 3D scene's settings are stored key by key, and the deck reads as before in the new order

  Scenario: Two people change different settings of an older deck after it was converted
    Given a deck stored before settings were split
    When Ana changes the shape's fill, which stores its settings one by one
    And their documents sync
    And Ana changes the shape's fill again while Budi changes its stroke
    And their documents sync once more
    Then the rectangle has Ana's fill and Budi's stroke for both of them

  Scenario: An older deck converted all at once merges from the first change
    Given a deck stored before settings were split
    When the server converts it
    Then every frontmatter and every block's settings are stored key by key, and the deck reads and writes as before
    And converting it again changes nothing
    When Ana changes the shape's fill while Budi changes its stroke
    And their documents sync
    Then the rectangle has Ana's fill and Budi's stroke for both of them

  Scenario: The demo deck writes the same Markdown in both shapes
    Given the demo deck and the sample deck
    Then a live document of each writes the same Markdown as the deck itself
    And so does a document of each stored before settings were split

  Scenario: Frontmatter entries stored the wrong way are found and repaired
    When Budi stores the key "class" of slide "details" as a plain value and the key "count" as a BigInt
    And their documents sync
    Then reading Ana's document shows slide "details" with layout "default" only
    And the check fails because the frontmatter of slide 2 is not stored the right way
    When the server repairs Ana's document
    Then the check passes and slide "details" still has layout "default" only
