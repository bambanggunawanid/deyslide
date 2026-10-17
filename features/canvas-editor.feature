Feature: Canvas editor
  As a person laying out slides
  I want to arrange elements on the slide itself with the mouse, the keyboard or my fingers
  So that I can design slides without writing Markdown

  Scenario: Clicking selects an element, and Shift adds another
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the rectangle
    Then the rectangle is selected, with eight resize handles and one for turning
    And others are told that Ana selected the rectangle
    When Ana clicks the note with Shift held
    Then the rectangle and the note are both selected, without handles
    When Ana clicks an empty part of the slide
    Then nothing is selected
    And the strip has one slide, which it cannot delete

  Scenario: Shift takes an element back out, a click picks one of several, and Escape clears
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the rectangle, then the note with Shift held
    And Ana clicks the note again with Shift held
    Then only the rectangle is selected
    When Ana adds the note with Shift once more, then clicks it alone
    Then only the note is selected
    When Ana presses Escape on the slide
    Then nothing is selected

  Scenario: Dragging moves an element without compiling the slide again
    Given Ana has the deck "Shapes" open in the Design view
    When Ana drags the rectangle 47 right and 31 down, and holds it there
    Then the rectangle's box is at 147, 131 and the preview got that position
    And the preview was not asked to render the slide again during the drag
    When Ana lets go
    Then the deck has the rectangle at 147, 131
    And the preview renders the slide with the rectangle at 147, 131, keeping it there meanwhile
    When the preview shows that render
    Then the preview no longer needs the drag's positions

  Scenario: A drag writes the deck at most every 50 ms, and the pointer reaches others as often
    Given Ana has the deck "Shapes" open in the Design view
    When Ana drags the rectangle through ten points at once, and holds it
    Then the deck changed once, with the first point
    And within 50 ms it changed once more, with the last point
    When Ana lets go, then moves the pointer through ten points on the slide at once
    Then others heard of the first point at once, and of the last within 50 ms, and of nothing between

  Scenario: A gesture writes only the elements it moves
    Given Ana has the deck "Shapes" open in the Design view
    When Ana drags the rectangle 50 right, pauses and lets go
    And Ana selects the note and holds its right handle still, while someone else puts the rectangle at 10, 10
    And Ana lets go of the handle
    Then the deck has the rectangle at 10, 10 and the note where it was
    When Ana drags the note 30 down, and meanwhile someone else puts the rectangle at 40, 40
    And Ana lets go of the note
    Then the deck has the rectangle at 40, 40 and the note at 500, 330

  Scenario: Elements moved together each keep part of themselves on the slide
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and the note and drags them 600 left with Alt held
    Then the deck has the rectangle 20 units on the slide, at -180, 100, and the note at 220, 300

  Scenario: A drag on a slide someone deletes leaves the next slide alone
    Given Ana has the deck "Twins" open in the Design view, whose two slides each have a box called "box" at 100, 100
    And Budi has the same deck open in another browser
    When Ana drags the box on slide 1 300 right and holds it there
    And Budi deletes slide 1
    Then Ana's page shows the other slide, "Slide 1 of 1"
    When Ana lets go
    Then the box on that slide is still at 100, 100

  Scenario: A drag snaps to the slide's center and shows a guide, unless Alt is held
    Given Ana has the deck "Shapes" open in the Design view
    When Ana drags the rectangle until its middle is 3 right of the slide's center line, and holds it there
    Then a guide shows on that line, with the rectangle's middle on it
    When Ana lets go
    Then the deck has the rectangle centered across the slide, and the guide is gone
    When Ana drags the rectangle 3 right with Alt held
    Then the deck has the rectangle 3 right of the center

  Scenario: Resizing from a corner, with and without keeping the ratio
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and drags its bottom right handle 100 right and 20 down
    Then the deck has the rectangle at 100, 100, 300 by 120
    When Ana drags the bottom right handle 60 right with Shift held
    Then the deck has the rectangle at 100, 100, 360 by 144

  Scenario: Resizing snaps the edge a handle pulls to the slide's center, unless Alt is held
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and drags its right handle until its right edge is 3 left of the slide's center line, and holds it there
    Then a guide shows on that line, with the rectangle's right edge on it
    When Ana lets go of the handle
    Then the deck has the rectangle at 100, 100, 390 by 100, and the guide is gone
    When Ana drags the right handle 3 right with Alt held
    Then the deck has the rectangle 393 wide

  Scenario: A text box with auto height keeps it while its right edge snaps
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a text box from the toolbar
    And Ana drags its bottom right handle until its right edge is 3 right of the note's right edge, near the note's top
    Then the text box ends at the note's right edge and still has an auto height

  Scenario: Pressing a handle without moving it changes nothing
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a text box from the toolbar
    And Ana presses its bottom right handle and lets go, after the pointer wandered a pixel
    Then the text box still has an auto height, and there is nothing new to undo

  Scenario: Turning with Shift snaps to 15 degrees
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and turns its rotate handle 40 degrees with Shift held
    Then the deck has the rectangle turned 45 degrees
    And the rectangle's box is drawn turned 45 degrees

  Scenario: An element at the top of the slide can still be turned
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and moves it up to the top of the slide
    Then its rotate handle sits below it, inside the stage
    When Ana turns that handle 40 degrees with Shift held
    Then the deck has the rectangle at 100, 0, turned 45 degrees

  Scenario: Arrow keys nudge the selection
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle and presses the right arrow
    Then the deck has the rectangle at 101, 100
    When Ana presses the down arrow with Shift held
    Then the deck has the rectangle at 101, 110

  Scenario: Control D copies and Delete removes
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the note and presses Control D
    Then the slide has a copy of the note at 520, 320, and only the copy is selected
    When Ana presses Delete
    Then the copy is gone and nothing is selected
    When Ana selects the rectangle and presses Backspace
    Then the slide has only the note

  Scenario: Keys belong to an open dialog, not to the canvas behind it
    Given Ana has the deck "Shapes" open in the Design view
    And Ana has the rectangle selected and the share dialog open, with focus back on the page
    When Ana presses Delete, an arrow key and Control Z
    Then the rectangle is still there, where it was, and still selected
    When Ana presses Escape
    Then the canvas leaves Escape to the dialog and keeps the rectangle selected

  Scenario: A drag with a pause is one undo step
    Given Ana has the deck "Shapes" open in the Design view
    When Ana drags the rectangle 40 right, waits longer than half a second, then drags it 40 down and lets go
    Then the deck has the rectangle at 140, 140
    When Ana presses Control Z
    Then the deck has the rectangle at 100, 100
    When Ana presses Control Shift Z
    Then the deck has the rectangle at 140, 140 again
    When Ana presses Control Z, then Control Y
    Then the deck has the rectangle back at 140, 140

  Scenario: Adding a text box and editing it in place
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a text box from the toolbar
    Then the slide has a text box saying "New text" in its middle, selected
    When Ana double clicks the text box
    Then an editor opens over the text box, as wide as it
    When Ana types " here" at the end
    Then the deck's text box says "New text here"
    When Ana presses Control Z in the editor
    Then the deck's text box says "New text" again, through the deck's undo
    When Ana presses Escape in the editor
    Then the editor closes and the text box stays selected

  Scenario: A double tap edits text, and a press outside closes the editor
    Given Ana has the deck "Shapes" open in the Design view
    When Ana double taps the note
    Then an editor opens over the note
    And no mouse presses follow the taps, so none can select a word in the editor
    When Ana taps the rectangle
    Then the editor closes and the rectangle is selected

  Scenario: Adding a 3D scene
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a 3D scene from the toolbar
    Then the slide has a 3D scene of 480 by 300 in its middle, selected
    And the deck's Markdown places a DeyslideScene3D component there
    And the inspector shows the 3D scene's camera, focus and zoom settings

  Scenario: Adding an image by its link
    Given Ana has the deck "Shapes" open in the Design view
    When Ana asks for an image and enters "not a link"
    Then the toolbar says "Enter a link that starts with https://, http:// or /."
    When Ana enters "https://example.com/cat.png"
    Then the slide has an image of "https://example.com/cat.png" in its middle, selected
    When Ana asks for an image again and presses Escape in the link field
    Then the link field closes, and the Image button has the focus

  Scenario: Shortcuts do not fire inside a text field
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the rectangle, opens the image link field and presses Backspace, Delete, an arrow, Control D and Control Z there
    Then the deck still has the rectangle at 100, 100, and the note

  Scenario: Enter presses a focused button while an element is selected, and edits text from the slide
    Given Ana has the deck "Shapes" open in the Design view
    When Ana selects the note, focuses the Rectangle button and presses Enter twice
    Then the slide has two new rectangles and no editor opened
    When Ana selects the note and presses Enter on the slide
    Then an editor opens over the note

  Scenario: Slides are added, copied and deleted in the strip
    Given Ana has the deck "Three" open in the Design view
    Then the strip shows "1 Intro", "2 Middle" and "3 End", with slide 1 current
    When Ana adds a slide
    Then the strip shows "1 Intro", "2 Empty slide", "3 Middle" and "4 End", with slide 2 current
    When Ana goes to slide 3 and copies it
    Then the strip shows "1 Intro", "2 Empty slide", "3 Middle", "4 Middle" and "5 End", with slide 4 current
    When Ana deletes the current slide
    Then the strip shows "1 Intro", "2 Empty slide", "3 Middle" and "4 End", with slide 4 current

  Scenario: Dragging a slide in the strip reorders the deck
    Given Ana has the deck "Three" open in the Design view
    When Ana drags slide 1 below slide 3 in the strip
    Then the strip shows "1 Middle", "2 End" and "3 Intro", with slide 3 current
    And the page still shows the slide "Intro", now "Slide 3 of 3"

  Scenario: The strip keeps the current slide in sight, whatever changes it
    Given Ana has a deck of 20 slides open in the Design view, with room for 5 slides in the strip
    When Ana goes to slide 8 with the next slide button
    Then the strip scrolled smoothly, only once slide 6 was out of sight, until slide 8 is the last slide in sight
    When Ana adds a slide after slide 8
    Then the strip scrolls smoothly until the new slide 9 is the last slide in sight
    When someone else adds a slide at the start of the deck
    Then the strip scrolls along, so the new slide, now slide 10, stays the last slide in sight
    When Ana goes back to slide 2 with the previous slide button
    Then the strip scrolls smoothly until slide 2 is the first slide in sight

  Scenario: Without motion the strip jumps to the current slide
    Given Ana asked her system for less motion, and has a deck of 20 slides open in the Design view, with room for 5 slides in the strip
    When Ana goes to slide 6 with the next slide button
    Then the strip jumps, without smooth scrolling, until slide 6 is the last slide in sight

  Scenario: On a phone the strip scrolls across to the current slide
    Given Ana has a deck of 20 slides open in the Design view on a phone, with room for 2 slides in the strip
    When Ana goes to slide 4 with the next slide button
    Then the strip scrolls smoothly across until slide 4 is the last slide in sight

  Scenario: A long press on a slide reorders it on touch, and a swipe does not
    Given Ana has the deck "Three" open in the Design view on a phone
    When Ana swipes across slide 1 with a finger
    Then the strip shows "1 Intro", "2 Middle" and "3 End", with slide 1 current
    When Ana rests a finger on slide 3 for half a second and drags it before slide 1
    Then the strip shows "1 End", "2 Intro" and "3 Middle", with slide 2 current

  Scenario: A view only deck shows no handles and no toolbar
    Given Budi shared the deck "Shapes" with Ana as a viewer, and Ana opened it in the Design view
    When Ana clicks the rectangle and drags it 50 right
    Then the rectangle is selected but shows no handles, and the deck did not change
    And there is no toolbar and no buttons to add, copy or delete slides
    When Ana presses Delete
    Then the deck still has the rectangle at 100, 100, and the note

  Scenario: The canvas waits while the assistant works
    Given Ana has the deck "Shapes" open in the Design view, with the assistant on
    And Ana selected the rectangle
    And Claude takes a while before changing the deck
    When Ana asks the assistant "Add a slide about recursion"
    Then the rectangle shows no handles and there is no toolbar
    And dragging the rectangle or pressing Delete changes nothing
    When Claude finishes
    Then the toolbar is back and the slide can be edited again

  Scenario: Others' selections and pointers show on the slide
    Given Ana has the deck "Shapes" open in the Design view
    And Budi has the same deck open in another browser, on slide 1 in the Design view
    When Budi selects the note and points at 300, 200
    Then Ana sees the note outlined in Budi's color, named "Budi Santoso"
    And Ana sees Budi's pointer, named "Budi Santoso", at 300, 200
    And the strip shows Budi's dot on slide 1
    When Ana opens the same deck on a phone too, on slide 1
    Then the strip still shows only Budi's dot on slide 1
    When Budi's pointer leaves the slide
    Then Ana no longer sees Budi's pointer
    When Ana moves the pointer to 400, 250 on the slide
    Then Budi sees Ana's pointer at 400, 250
    When Ana's pointer leaves the slide
    Then Budi sees no pointer from Ana

  Scenario: Two fingers zoom, and the zoom menu and the wheel change it too
    Given Ana has the deck "Shapes" open in the Design view
    Then the zoom shows "Fit" at 100%
    When Ana spreads two fingers on the slide from 100 to 200 pixels apart
    Then the zoom is 200%
    When Ana chooses 50% in the zoom menu
    Then the zoom is 50%
    When Ana chooses Fit in the zoom menu
    Then the zoom shows "Fit" at 100% again
    When Ana turns the wheel up with Control held over the slide
    Then the zoom is 122%

  Scenario: A pinch that starts on an element leaves it where it was
    Given Ana has the deck "Shapes" open in the Design view
    When Ana rests a finger on the rectangle and slides it 20 left, then puts a second finger down and spreads both
    Then the zoom changed, the deck has the rectangle at 100, 100 and the preview shows it there
    And there is nothing new to undo or redo

  Scenario: On a touch screen a small box keeps its middle free of handles
    Given Ana has the deck "Shapes" open in the Design view on a touch screen
    When Ana adds a text box from the toolbar
    Then the text box shows only its four corner handles, outside it
    And its rotate handle sits clear of the corner handles above it
    When Ana double taps the middle of the text box
    Then an editor opens over the text box

  Scenario: Text with auto height is as tall as the preview lays it out
    Given Ana has the deck "Title" open in the Design view
    Then the title's box is 96 tall, a first guess from its Markdown
    When the preview reports the title laid out 130 tall
    Then the title's box is 130 tall
    And a click 120 below the title's top selects it

  Scenario: The inspector places the selected element, and refuses a value it cannot use
    Given Ana has the deck "Shapes" open in the Design view
    Then the inspector shows the slide's settings
    When Ana clicks the rectangle
    Then the inspector shows "Rectangle" at 100, 100, 200 by 100, turned 0
    When Ana enters 150 for X and 30 for the turn in the inspector
    Then the deck has the rectangle at 150, 100, turned 30
    When Ana enters -20 for the width
    Then the width field says "Enter 8 or more." and the deck has the rectangle 200 wide
    When Ana enters 100000 for X
    Then the X field says "Keep part of it on the slide." and the deck has the rectangle at 150
    When Ana enters "far" for Y
    Then the Y field says "Enter a number." and the deck has the rectangle at 150, 100
    When Ana enters nothing for the height
    Then the height field says "Enter a number." since a rectangle needs a height
    When Ana presses Escape in the X and Y fields
    Then the X and Y fields show 150 and 100 again, with no problem
    When Ana drags the rectangle 50 right on the slide
    Then the X field shows 200
    When Ana presses Control Z twice on the slide
    Then the deck has the rectangle at 150, 100, turned 0

  Scenario: A field whose typing was taken back follows the deck again
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the rectangle
    And Ana types 5 after the X, takes it back with Backspace, and leaves the field
    And Ana nudges the rectangle 10 right with Shift and the right arrow
    Then the X field shows 110
    When Ana presses Enter in the X field
    Then the deck still has the rectangle at 110

  Scenario: A text box's height can be left to its content
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a text box from the toolbar
    And Ana enters 120 for the height in the inspector
    Then the deck has the text box 120 tall
    When Ana enters nothing for the height
    Then the text box has an auto height again

  Scenario: A shape's fill, outline and outline width
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the rectangle
    And Ana enters "#ff0000" for the fill in the inspector
    Then the deck's Markdown draws the rectangle with fill="#ff0000"
    When Ana enters "not a color" for the fill
    Then the fill field says "Enter a color, such as #38bdf8 or red." and the fill is still "#ff0000"
    When Ana enters "notacolor", then "rgb(foo)" for the fill
    Then the fill field still says "Enter a color, such as #38bdf8 or red." and the fill is still "#ff0000"
    When Ana picks "#00ff00" for the outline and enters 4 for the outline width
    Then the rectangle has a "#00ff00" outline 4 wide
    When Ana enters -1 for the outline width
    Then the outline width field says "Enter 0 or more." and the outline is still 4 wide
    When Ana enters nothing for the fill
    Then the rectangle has no fill of its own, so it shows the default

  Scenario: An image's link and description
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds an image of "https://example.com/cat.png" from the toolbar
    And Ana enters "javascript:alert(1)" for the image link in the inspector
    Then the image link field says "Enter a link that starts with https://, http:// or /." and the image still shows "https://example.com/cat.png"
    When Ana enters "/pictures/dog.png" for the image link and "A sleepy dog" for its description
    Then the deck has an image of "/pictures/dog.png" described as "A sleepy dog"

  Scenario: Code with Magic Move steps
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds code from the toolbar
    Then the inspector shows one step in "ts"
    When Ana enters "type script" for the language
    Then the language field says "A language name has no spaces or backticks." and the code is still in "ts"
    When Ana adds a Magic Move step and enters "const greeting = 'Hi'" as its code
    Then the deck's Markdown has a Magic Move block with both steps
    When Ana enters a line starting with three backticks in the second step
    Then the second code field says "A Magic Move step cannot have a line that starts with ```." and the deck keeps both steps
    When Ana presses Escape in the second code field and removes the first step
    Then the code has one step, "const greeting = 'Hi'", in a plain code block

  Scenario: A 3D scene's camera, model and switches
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a 3D scene from the toolbar
    And Ana clicks an empty part of the slide, then double clicks the 3D scene
    Then the inspector shows "3D scene", with the focus in its first field
    When Ana enters "1, 2" for the camera position
    Then the camera position field says "Enter three numbers, such as 7, 5, 9."
    When Ana enters "1, 2, 3" for the camera position, "0 0 0" for where it looks and "server" for the focus
    And Ana enters 0 for the zoom level
    Then the zoom level field says "Enter a number above 0."
    When Ana enters 2 for the zoom level, 0.5 for the spin, 6 for the smoothing and "intro" for the scene id
    And Ana enters "/models/robot.glb" for the model
    And Ana turns on orbit controls and seeing through to the slide
    Then the 3D scene's props are all set, and its Markdown binds them
    When Ana enters nothing for the camera position
    Then the 3D scene has no camera position of its own

  Scenario: An algorithm player's link and switches
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds an algorithm player from the toolbar
    Then it plays on its own, loops and shows controls
    When Ana turns off playing on its own and looping
    Then the deck's algorithm player does not play on its own or loop, and still shows controls
    When Ana enters 2 for the quality
    Then the quality field says "Enter a number from 0 to 1."
    When Ana enters nothing for the animation link
    Then the animation link field says "Enter a link that starts with https://, http:// or /."
    When Ana enters "/animations/quick-sort.js" for the animation link
    Then the deck's algorithm player plays "/animations/quick-sort.js"

  Scenario: A live sandbox's starting values
    Given Ana has the deck "Shapes" open in the Design view
    When Ana adds a live sandbox from the toolbar
    Then the inspector lists one value, "count", a number set to 0
    When Ana renames "count" to "total" and adds a value
    Then the sandbox starts with total 0 and value2 0
    When Ana makes value2 a switch and turns it on
    Then the sandbox starts with total 0 and value2 on
    When Ana renames value2 to "total"
    Then the name field says "Another value has that name."
    When Ana renames value2 to "__proto__"
    Then the name field says "Choose another name." and the sandbox still starts with total 0 and value2 on
    When Ana enters "many" as the value of total
    Then the value field says "Enter a number." and total is still 0
    When Ana removes total
    Then the sandbox starts with value2 on only

  Scenario: What Ana types in a step or a value goes to its row while Budi removes another
    Given Ana has the deck "Shapes" open in the Design view
    And Budi has the same deck open in another browser
    When Ana adds code with the steps "one", "two" and "three"
    And Ana types " edited" at the end of the second step's code
    And Budi removes the first step
    And Ana leaves the code field
    Then the code's steps are "two edited" and "three"
    When Ana types " again" at the end of the first step's code
    And Budi removes the first step and changes "three" to "three by Budi" in one change
    And Ana leaves the first step's code field
    Then the code's only step is "three by Budi", and Ana's typing went to no step
    When Ana adds a live sandbox starting with a, b and c at 0
    And Ana types 5 as the value of b
    And Budi removes a
    And Ana leaves the value field
    Then the sandbox starts with b at 5 and c at 0

  Scenario: The inspector moves an element forward, backward, to the front and to the back
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the rectangle
    Then the rectangle cannot go further back, only forward
    When Ana brings the rectangle forward
    Then the slide paints the note, then the rectangle
    And the rectangle cannot go further forward
    When Ana sends the rectangle to the back
    Then the slide paints the rectangle, then the note
    When Ana selects the note and sends it backward
    Then the note is painted first, under the rectangle
    When Ana brings the note to the front
    Then the note is painted last, over the rectangle

  Scenario: Markdown that flows in the slide always shows under movable elements
    Given Ana has the deck "Flow" open in the Design view
    When Ana clicks the box
    Then the box has nothing to go in front of or behind

  Scenario: An element can go behind Markdown laid over the slide
    Given Ana has the deck "Backdrop" open in the Design view
    When Ana clicks the box
    Then the box can go behind the backdrop, but not further forward
    When Ana sends the box to the back
    Then the slide paints the box first, under the backdrop, and the flowing Markdown stays last
    And the deck's Markdown starts the slide with the box
    When Ana brings the box forward
    Then the slide paints the backdrop, then the box

  Scenario: Deleting from the inspector
    Given Ana has the deck "Shapes" open in the Design view
    When Ana clicks the note and deletes it from the inspector
    Then the slide has only the rectangle, and the inspector shows the slide's settings
    When Ana adds a text box, then clicks the rectangle with Shift held
    Then the inspector says "2 elements selected"
    When Ana deletes them from the inspector
    Then the slide has no elements, and nothing is selected

  Scenario: Slide settings
    Given Ana has the deck "Shapes" open in the Design view
    Then the layout menu offers "Auto (cover)", then the preview's own layouts
    When Ana chooses the "center" layout and the "slide-up" transition
    Then the slide's frontmatter has the "center" layout and the "slide-up" transition, and keeps its theme
    And the preview renders the slide with the "center" layout
    When Ana enters "text-center" for the class and "#123456" for the background
    Then the slide's frontmatter has the class "text-center" and the background "#123456"
    When Ana enters "not a thing at all" for the background
    Then the background field says "Enter a color such as #0f172a, or an image link." and the background is still "#123456"
    When Ana enters "/pictures/sky.png" for the background
    Then the slide's background is "/pictures/sky.png"
    When Ana enters 2.5 for the clicks
    Then the clicks field says "Enter a whole number." and the slide names no clicks
    When Ana enters 3 for the clicks, then nothing for the class
    Then the slide's frontmatter has 3 clicks and no class
    When Ana chooses the default layout
    Then the slide's frontmatter names no layout
    When Ana presses Control Z on the slide
    Then the slide's frontmatter has the "center" layout again

  Scenario: Markdown that flows in the slide is edited in place or made movable
    Given Ana has the deck "Flow" open in the Design view
    Then the inspector lists the slide's Markdown blocks "# Sorting" and "Bubble sort swaps neighbours."
    When Ana edits the first block and types " fast" at its end
    Then the deck's first block says "# Sorting fast"
    When Ana presses Control Z in the block editor
    Then the deck's first block says "# Sorting" again, through the deck's undo
    When Ana makes the second block movable
    Then the slide has a text element "Bubble sort swaps neighbours." at 56, 40, 868 wide with an auto height, selected
    And the deck's Markdown places it in a v-drag where the block was, after the box
    And the inspector shows "Text" at 56, 40

  Scenario: A Markdown block with slot markers cannot be made movable
    Given Ana has the deck "Columns" open in the Design view
    When Ana makes the slide's Markdown block movable
    Then the inspector says "A block with a slot marker such as ::right::, a script or a style cannot be made movable."
    And the slide is unchanged

  Scenario: A Markdown block laid over the slide cannot be made movable
    Given Ana has the deck "Backdrop" open in the Design view
    When Ana makes the backdrop's Markdown block movable
    Then the inspector says "This block is laid over the slide by its class or style, so it cannot be made movable."
    And the slide is unchanged

  Scenario: A Markdown block's editor keeps Ana's place when someone moves its slide
    Given Ana has the deck "Flow" open in the Design view
    And Budi has the same deck open in another browser
    When Ana edits the first block and types " fast" at its end
    And Ana puts the cursor after "#"
    And Budi copies the slide and moves Ana's slide after the copy
    Then the block editor still has the focus, with the cursor after "#"
    When Ana types " Quick"
    Then Budi's deck has "# Quick Sorting fast" on Ana's slide, and the copy keeps "# Sorting fast"

  Scenario: The notes editor keeps Ana's place when someone moves the slide
    Given Ana has the deck "Flow" open in the Design view
    And Budi has the same deck open in another browser
    When Ana puts the cursor in the notes after "Mention"
    And Budi copies the slide and moves Ana's slide after the copy
    Then the notes editor still has the focus, with the cursor after "Mention"
    When Ana types " only"
    Then Budi's deck has the notes "Mention only the cost." on Ana's slide

  Scenario: Speaker notes are edited live with everyone else
    Given Ana has the deck "Flow" open in the Design view
    And Budi has the same deck open in another browser
    Then the inspector shows the speaker notes "Mention the cost."
    When Ana types " Twice." at the end of the notes
    Then Budi's deck has the notes "Mention the cost. Twice."
    When Budi changes the notes to "Mention the cost first. Twice."
    Then Ana's notes editor shows "Mention the cost first. Twice."
    When Ana presses Control Z in the notes editor
    Then the deck's notes say "Mention the cost first." again

  Scenario: A viewer sees the inspector, read only
    Given Budi shared the deck "Flow" with Ana as a viewer, and Ana opened it in the Design view
    Then the inspector's settings cannot be changed, and there is no button to make a block movable
    And the notes editor cannot be typed in
    When Ana clicks the box
    Then the inspector shows the box's place, read only, with no buttons to order or delete it

  Scenario: The inspector is read only while the assistant works
    Given Ana has the deck "Shapes" open in the Design view, with the assistant on
    And Ana selected the rectangle
    And Claude takes a while before changing the deck
    When Ana asks the assistant "Add a slide about recursion"
    Then the inspector's fields cannot be changed, and it has no buttons to order or delete
    When Claude finishes
    Then the inspector's fields can be changed again

  Scenario: Images come from the project's media library
    Given Ana is signed in, the server keeps media, and Ana's project has the images "cat.png" and "dog.png"
    And Ana has the deck "Shapes" open in the Design view
    When Ana asks for an image
    Then the toolbar offers the link field and the project's images, newest first: "dog.png" and "cat.png"
    When Ana picks "cat.png"
    Then the slide has an image of "cat.png" by its media address, described as "cat", selected
    And the preview gets a signed link for that address, which needs no cookie
    When Ana opens the project images in the inspector and uploads "blue-bird.png"
    Then the upload went to Ana's project, and the image now shows "blue-bird.png" by its media address, described as "blue bird"
    When an upload fails because storage is full
    Then the picker says why

  Scenario: A deck in this browser offers only a link for images
    Given Ana has a deck "Shapes" in this browser, open in the Design view, and the server keeps media
    When Ana asks for an image
    Then the toolbar offers only the link field
    When Ana adds an image of "https://example.com/cat.png" from the link field
    Then the inspector offers no project images for it

  Scenario: A deck on this device offers only a link for images, even when signed in
    Given Ana is signed in, the server keeps media, and Ana has a deck "Shapes" on this device, open in the Design view
    When Ana asks for an image
    Then the toolbar offers only the link field
    When Ana adds an image of "https://example.com/cat.png" from the link field
    Then the inspector offers no project images for it

  Scenario: Slide pictures in the strip load as they come into view, twelve at most
    Given Ana has a deck of 20 slides open in the Design view on a wide screen
    Then the strip shows no slide pictures yet
    When slides 1 to 3 of the strip come into view
    Then pictures of slides 1 to 3 show, each drawn in print mode with every click done
    When slides 1 to 16 are in view
    Then 12 pictures show, for slides 1 to 12
    When Ana goes to slide 16
    Then 12 pictures show, for slides 5 to 16
    When slide 16 scrolls out of view
    Then its picture is gone, and slide 4 has one again
    When someone changes slide 5's title to "Five, edited"
    Then slide 5's picture shows "Five, edited" once the change settles

  Scenario: A narrow screen shows titles only in the strip
    Given Ana has a deck of 20 slides open in the Design view on a narrow screen
    When slides 1 to 3 of the strip come into view
    Then the strip shows no slide pictures, only numbers and titles

  Scenario: On a phone the inspector is a sheet at the bottom
    Given Ana has the deck "Shapes" open in the Design view on a phone
    Then the inspector is a closed sheet whose bar says "Slide", with room for the bar at the end of the page
    When Ana taps the rectangle
    Then the sheet's bar says "Rectangle", and the sheet stays closed
    When Ana opens the sheet
    Then the sheet shows the rectangle's place and size
    When Ana closes the sheet and double taps the rectangle
    Then the sheet opens on the rectangle's settings
