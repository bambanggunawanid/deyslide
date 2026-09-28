Feature: Animation bundle address
  As a deck author
  I want to write "/animations/<name>.js" no matter where the deck is hosted
  So that the same slide works in dev, on a root domain and under a sub path

  Scenario Outline: Resolve the player source
    Given the deck is served from "<base>" on "<page>"
    When the player source is "<src>"
    Then the player imports "<url>"

    Examples:
      | base    | page                              | src                         | url                                                |
      | /       | http://localhost:3030/4           | /animations/bubble-sort.js  | http://localhost:3030/animations/bubble-sort.js     |
      | /talks/ | https://example.com/talks/4       | /animations/bubble-sort.js  | https://example.com/talks/animations/bubble-sort.js |
      | /talks  | https://example.com/talks/4       | /animations/bubble-sort.js  | https://example.com/talks/animations/bubble-sort.js |
      | /       | http://localhost:3030/4           | https://cdn.example.com/a.js | https://cdn.example.com/a.js                       |
      | /       | http://localhost:3030/slides/4    | ./local.js                  | http://localhost:3030/slides/local.js               |
