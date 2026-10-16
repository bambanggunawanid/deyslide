Feature: Presenting a deck
  As a person giving a talk
  I want to present a deck full screen, with a presenter view beside it
  So that I can step through slides and clicks the way Slidev does, live or by itself

  # Moving through a talk: slides counted from 1, clicks from 0.
  # The deck in these scenarios has slides with 0, 2, 3, 0 and 0 clicks.

  Scenario: Next steps through a slide's clicks, then to the next slide
    Given a talk on slide 2 at click 0
    When the presenter moves on 3 times
    Then the talk is on slide 3 at click 0

  Scenario: Going back into a slide opens it at its last click, as in Slidev
    Given a talk on slide 4 at click 0
    When the presenter goes back
    Then the talk is on slide 3 at click 3
    When the presenter goes back again
    Then the talk is on slide 3 at click 2

  Scenario: Going back into a slide whose clicks are not known yet asks for every click
    Given a talk on slide 4 at click 0, where only slide 4's clicks are known
    When the presenter goes back
    Then the talk is on slide 3 asking for every click
    When the preview says slide 3 has 3 clicks
    Then the talk is on slide 3 at click 3

  Scenario: A slide whose clicks are not known yet steps one click at a time
    Given a talk on slide 2 at click 0, where no clicks are known
    When the presenter moves on
    Then the talk is on slide 2 at click 1
    When the preview says slide 2 has 0 clicks
    Then the talk is on slide 2 at click 0

  Scenario: The talk stops at either end
    Given a talk on slide 5 at click 0
    When the presenter moves on
    Then the talk is still on slide 5 at click 0
    Given a talk on slide 1 at click 0
    When the presenter goes back
    Then the talk is still on slide 1 at click 0

  Scenario: Going to a slide, the first and the last
    Given a talk on slide 3 at click 2
    When the presenter goes to slide 2
    Then the talk is on slide 2 at click 0
    When the presenter goes to slide 9
    Then the talk is on slide 5 at click 0
    When the presenter goes to the first slide
    Then the talk is on slide 1 at click 0
    When the presenter goes to the last slide
    Then the talk is back on slide 5 at click 0

  Scenario Outline: A typed slide number
    When the presenter types "<typed>" to go to a slide
    Then the talk goes to <where>

    Examples:
      | typed | where       |
      | 3     | slide 3     |
      | 5     | slide 5     |
      | 0     | nowhere     |
      | 6     | nowhere     |
      | two   | nowhere     |
      | 2.5   | nowhere     |

  Scenario: Autoplay shows each step for the slide's videoDwell seconds, else 4 seconds
    Given a talk on slide 1 at click 0, where slide 2 has videoDwell 2
    When autoplay starts
    Then after 3999 ms the talk is on slide 1 at click 0
    And after 1 ms more the talk is on slide 2 at click 0
    And after 1999 ms more the talk is still on slide 2 at click 0
    And after another 1 ms the talk is on slide 2 at click 1

  Scenario: A move by hand gives the new step its whole time
    Given a talk on slide 1 at click 0
    When autoplay starts
    And after 3000 ms the presenter moves on by hand
    Then after 3999 ms the talk is on slide 2 at click 0
    And after 1 ms more the talk is on slide 2 at click 1

  Scenario: Autoplay stops at the end unless it loops
    Given a talk on slide 5 at click 0
    When autoplay starts
    Then after 4000 ms autoplay has stopped on slide 5 at click 0
    Given the same talk on slide 5 at click 0
    When autoplay starts with the loop on
    Then after 4000 ms the talk is on slide 1 at click 0 and autoplay still runs

  Scenario Outline: Keys while presenting
    When the presenter presses "<key>"
    Then the key means "<action>"

    Examples:
      | key        | action     |
      | ArrowRight | next       |
      | ArrowDown  | next       |
      | Space      | next       |
      | PageDown   | next       |
      | n          | next       |
      | Enter      | next       |
      | ArrowLeft  | previous   |
      | ArrowUp    | previous   |
      | PageUp     | previous   |
      | p          | previous   |
      | Backspace  | previous   |
      | Home       | first      |
      | End        | last       |
      | f          | fullscreen |
      | F          | fullscreen |
      | o          | overview   |
      | g          | goto       |
      | a          | autoplay   |
      | Escape     | escape     |
      | Control+p  | nothing    |
      | x          | nothing    |

  Scenario Outline: Taps and swipes on the slide
    When the presenter <gesture> on a 900 pixel wide screen
    Then the gesture means "<action>"

    Examples:
      | gesture                       | action   |
      | taps at 100                   | previous |
      | taps at 299                   | previous |
      | taps at 300                   | next     |
      | taps at 800                   | next     |
      | swipes from 600 to 400        | next     |
      | swipes from 400 to 600        | previous |
      | drags 30 pixels down from 500 | nothing  |
      | clicks with a mouse at 100    | previous |
      | clicks with a mouse at 800    | next     |
      | drags a mouse from 600 to 400 | nothing  |
      | drags a mouse from 400 to 600 | nothing  |

  # The pages, in the web app.

  Scenario: The deck page and the project page have a Present button
    Given the demo deck "Sorting" is in this browser
    When I press Present next to the deck on the project page
    Then the audience view shows slide 1 of 5 alone, without the site header
    When I go back to the deck page and press Present
    Then the audience view shows slide 1 of 5 alone again
    And the deck page has a "Presenter view" button too

  Scenario: A viewer of a shared deck presents it, and the deck opens once
    Given Budi shared the demo deck "Sorting" with Ana as a viewer
    When Ana presents the deck
    Then the audience view shows slide 1 of 5
    When the project lists refresh 3 times
    Then the deck was opened once, read only, and the slide frame stayed the same

  Scenario: A deck that cannot be opened says why, in both views
    Given Ana is signed in, with the demo deck "Sorting" in the account, and the connection is down
    When Ana presents the deck
    Then the audience view says "Offline. Changes sync when you are back online."
    When Ana opens the presenter view instead
    Then the presenter view says "Offline. Changes sync when you are back online." and shows no slide counter

  Scenario: Presenting opens the deck read only, and live changes show up
    Given Ana is signed in, with the demo deck "Sorting" in the account
    When Ana presents the deck
    Then the deck was opened read only
    When Budi changes the title of slide 1 to "Changed live" in another browser
    Then the audience view shows the title "Changed live"

  Scenario: Keys step through clicks and slides, with a transition only between slides
    Given a deck whose transition is "slide-left", with a second slide of 2 clicks whose transition is "fade", is presented in this browser
    Then the audience view shows slide 1 at click 0, without a transition
    When the presenter presses "ArrowRight"
    Then the audience view shows slide 2 at click 0, coming in with "slide-left", the transition of slide 1
    When the presenter presses "Space" and "n"
    Then the audience view shows slide 2 at click 2, without a transition
    When the presenter presses "ArrowRight" again
    Then the audience view shows slide 3 at click 0, coming in with "fade", the transition of slide 2
    When the presenter presses "ArrowLeft"
    Then the audience view shows slide 2 at click 2, coming back with "fade", the transition of slide 2
    When the presenter presses "End" and then "Home"
    Then the audience view shows slide 1 at click 0

  Scenario: A slide that does not compile does not stop the talk
    Given a deck whose second slide does not compile is presented in this browser
    When the presenter presses "ArrowRight"
    Then the audience view shows slide 2 at click 0 and the error
    When the presenter presses "ArrowRight" again
    Then the audience view shows slide 3 at click 0
    When the presenter presses "ArrowLeft" twice
    Then the audience view shows slide 1 at click 0

  Scenario: Keys pressed before a slide is drawn all count
    Given the demo deck "Sorting" is presented in this browser, with a preview slow to draw
    When the presenter presses "ArrowRight" 3 times before slide 1 is drawn
    And the preview draws the slides
    Then the audience view shows slide 2 at click 2

  Scenario: Going back twice before a slide is drawn stops at its click before the last
    Given the demo deck "Sorting" is presented from slide 3 in this browser, with a preview slow to draw
    When the presenter presses "ArrowLeft" twice before slide 3 is drawn
    And the preview draws the slides
    Then the audience view shows slide 2 at click 1

  Scenario: A slide that gains a click while presenting opens at its new last click
    Given a deck whose second slide has 2 clicks is presented in this browser, on slide 3
    When someone adds a third click to slide 2
    And the presenter presses "ArrowLeft"
    Then the audience view shows slide 2 at click 3

  Scenario: Taps and swipes move the talk
    Given the demo deck "Sorting" is presented in this browser
    When the presenter taps the right side of the slide
    Then the audience view shows slide 2 at click 0
    When the presenter swipes left on the slide
    Then the audience view shows slide 2 at click 1
    When the presenter taps the left third of the slide
    Then the audience view is back on slide 2 at click 0
    When the presenter swipes right on the slide
    Then the audience view shows slide 1 at click 0
    When the presenter drags the mouse from right to left across the slide, to select its text
    Then the audience view still shows slide 1 at click 0

  Scenario: A press on the slide's own controls is left to the slide
    Given the demo deck "Sorting" is presented in this browser
    When the presenter presses a button inside the slide
    Then the audience view still shows slide 1 at click 0
    When the presenter taps the slide itself, on its right side
    Then the audience view shows slide 2 at click 0
    When the presenter presses "ArrowRight" while the slide has the focus
    Then the audience view shows slide 2 at click 1
    When the presenter presses "ArrowRight" while typing in a field inside the slide
    Then the audience view still shows slide 2 at click 1

  Scenario: Ticking Loop or pressing a control leaves the keys to the talk
    Given the demo deck "Sorting" is presented in this browser
    Then a press on the controls does not take the focus
    When the presenter ticks Loop and presses "ArrowRight" on it
    Then the audience view shows slide 2 at click 0
    When the presenter presses "Space" on the Loop box
    Then the audience view still shows slide 2 at click 0

  Scenario: On a touch screen, a button brings back the controls without moving the talk
    Given the demo deck "Sorting" is presented on a touch screen
    When the presenter taps the right side of the slide with a finger
    Then the audience view shows slide 2 at click 0, and the controls stay hidden
    When the presenter taps the button that shows the controls
    Then the controls show and the audience view still shows slide 2 at click 0

  Scenario: The overview shows every slide, and a click goes there
    Given the demo deck "Sorting" is presented in this browser
    When the presenter presses "o"
    Then the overview shows 5 slides with their titles, slide 1 marked as the one on screen
    And the overview draws a picture of each slide in print mode at its last click
    When the presenter picks slide 4 in the overview
    Then the overview is closed and the audience view shows slide 4 at click 0

  Scenario: Tiles still waiting for their picture say so
    Given the demo deck "Sorting" is presented in this browser, with a preview slow to draw
    When the presenter presses "o"
    Then every tile of the overview says its picture is being drawn
    When the preview draws the slides
    Then every tile shows its picture, and none says it is being drawn

  Scenario: The overview draws the slide on screen first
    Given the demo deck "Sorting" is presented from slide 3 in this browser
    When the presenter presses "o"
    Then the overview draws slides 3, 4, 5, 1 and 2, in that order

  Scenario: Go to a slide by its number
    Given the demo deck "Sorting" is presented in this browser
    When the presenter presses "g" and types "9"
    Then the page says "Type a slide number from 1 to 5."
    When the presenter types "3" instead
    Then the audience view shows slide 3 at click 0

  Scenario: A tap beside the slide number form closes it
    Given the demo deck "Sorting" is presented in this browser
    When the presenter presses "g" and then taps the slide
    Then the form is closed and the audience view still shows slide 1 at click 0

  Scenario: Escape leaves the overview, then full screen, then the talk
    Given the demo deck "Sorting" is presented in this browser, full screen
    When the presenter presses "o" and then "Escape"
    Then the overview is closed and the page is still full screen
    When the presenter presses "Escape"
    Then the page is no longer full screen
    When the presenter presses "Escape" again
    Then the deck page shows again

  Scenario: Escape in the audience window a presenter view opened closes it
    Given the demo deck "Sorting" is presented in the audience window its presenter view opened
    Then the controls offer no Presenter view
    When the presenter presses "Escape"
    Then the window closes, and the page does not open the editor

  Scenario: In the desktop app, Escape keeps the audience window on the talk
    Given the demo deck "Sorting" is presented in the app's audience window
    Then the controls offer neither Presenter view nor Exit
    When the presenter presses "Escape"
    Then the window stays on the talk

  Scenario: Cinematic mode plays the talk by itself
    Given a deck whose slides each set videoDwell to 0.05 seconds is presented in this browser
    When the presenter presses "a"
    Then the mode switch says Cinematic
    And the talk moves on by itself to slide 2 at click 0
    When the presenter presses "a" again
    Then the mode switch says Live Teaching

  Scenario: The address can start Cinematic mode with the loop on
    Given a deck whose slides each set videoDwell to 0.05 seconds is presented in this browser with "?mode=cinematic&loop=1"
    Then the mode switch says Cinematic and Loop is ticked
    And the talk plays to slide 3 and starts again from slide 1

  Scenario: The cursor and the controls hide after 2 seconds without moving
    Given the demo deck "Sorting" is presented in this browser
    When the pointer rests for 2 seconds
    Then the cursor and the controls are hidden
    When the pointer moves
    Then the controls show again

  Scenario: Once the pointer rests, the slide hides it too, and its own buttons still work
    Given the demo deck "Sorting" is presented in this browser
    When the pointer rests for 2 seconds on a button inside the slide
    Then the slide is asked to hide the cursor, and nothing is laid over the slide
    When the presenter presses that button
    Then the audience view still shows slide 1 at click 0
    And the slide is asked to show the cursor again

  Scenario: Presenting starts on the slide open in the editor, and each view keeps the slide
    Given the demo deck "Sorting" is open in the editor on slide 3
    When I press Present
    Then the audience view shows slide 3 of 5
    When the presenter presses "ArrowRight" and opens the presenter view from the controls
    Then the presenter view shows slide 4 of 5
    And it asked to open the audience window on slide 4
    When the presenter presses "Escape" in the presenter view
    Then the editor shows slide 4 of 5
    When I open the presenter view from the editor
    Then the presenter view shows slide 4 of 5 again

  Scenario: The presenter view shows the slide, the next step, the notes, a timer and the clock
    Given the demo deck "Sorting" is open in the presenter view
    Then it shows slide 1 of 5, the next step "Slide 2" and the notes "Welcome everyone."
    And it asked to open the audience window at the present page of the deck, on slide 1
    When the presenter presses its Next button 2 times
    Then it shows slide 2 at click 1, the next step "Click 2 of slide 2" and the notes "Step 1: ask the room"
    When 65 seconds pass
    Then the timer reads "01:05"
    When the presenter resets the timer
    Then the timer reads "00:00"

  Scenario: The presenter view's notes follow the clicks, and their links open beside it
    Given a deck whose speaker notes have a link and a click marker is open in the presenter view
    Then the notes show the part before the marker as the current one, and no marker text
    And the link in the notes opens in a new window
    When the presenter presses its Next button
    Then the notes show the part after the marker as the current one
    When the presenter presses its Next button again
    Then the presenter view shows slide 2 of 2 and no click counter, since that slide has no clicks

  Scenario: Clicking the slides in the presenter view leaves the keys to it
    Given the demo deck "Sorting" is open in the presenter view
    Then its slides take no clicks and no focus

  Scenario: A click on the presenter view's buttons leaves Space and Enter to the talk
    Given the demo deck "Sorting" is open in the presenter view
    Then a press on its Previous, Next, Reset and audience buttons does not take the focus

  Scenario: On a phone, the presenter view puts the notes before the next step
    Given the demo deck "Sorting" is open in the presenter view
    Then the page shows the slide on screen, then the notes, then the next step
    And on wide screens the next step and the notes sit beside the slide

  Scenario: The presenter and audience windows stay in step, and either can drive
    Given the demo deck "Sorting" is open in the presenter view and the audience view, in two windows
    When the presenter presses Next in the presenter view
    Then both windows show slide 2 at click 0
    When the presenter taps the right side of the slide in the audience view
    Then both windows show slide 2 at click 1
    When the audience view is opened again
    Then it asks where the talk is and goes to slide 2 at click 1

  Scenario: On Android the presenter view has no second window
    Given the demo deck "Sorting" is open in the presenter view on a phone with one window
    Then it offers the audience view in the same window instead of opening a window

  # The channel between the windows, on each platform.

  Scenario: In the browser, the windows talk over a BroadcastChannel and the audience opens with window.open
    Given two browser windows present the deck "d1", and one presents the deck "d2"
    When a window of the deck "d1" posts where the talk is
    Then the other window of "d1" hears it, and the window of "d2" does not
    When the presenter opens the audience window twice
    Then the browser opened one window named "deyslide-present:d1", loaded "/p/p1/d/d1/present" in it once, and brought it forward the second time

  Scenario: A presenter view that reloads finds its audience window without loading it again
    Given the audience window of the deck "d1" shows its talk, opened before the presenter view reloaded
    When the presenter opens the audience window
    Then the browser found that window by its name, did not load it again, and brought it forward

  Scenario: An audience window that went to another page shows the talk again
    Given the audience window of the deck "d1" shows the deck's editor
    When the presenter opens the audience window
    Then the browser loaded "/p/p1/d/d1/present" in that window again

  Scenario: In the desktop app, the windows talk through the app
    Given the Deyslide app on a computer, in its main window
    When the presenter opens the audience window of the deck "d1" in the project "p1"
    Then the app got the command "present_open" for that deck
    When the presenter window posts where the talk is
    Then the app sent the event "present-sync" for the deck "d1" from the main window
    And a "present-sync" from the audience window reaches the page, while its own and other decks' do not

  Scenario: On Android the presenter has one window
    Given the Deyslide app on Android
    Then the present channel cannot open an audience window, and asking for one opens nothing

  Scenario: Full screen in the desktop app sets the window full screen
    Given the Deyslide app on a computer, in its main window
    When the page asks for full screen, and then to leave it
    Then the app window was set full screen, and then back
