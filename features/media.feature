Feature: Private media uploads
  As a signed in person
  I want to upload images, video and audio for my slides
  So that my decks can use them while nobody else can open my files

  Background:
    Given the Deyslide API with media storage
    And Ana is signed in

  Scenario: Upload an image
    When Ana asks to upload "diagram.png" as "image/png" with 2048 bytes
    Then she gets an upload link that expires in 15 minutes and is signed for "image/png" and 2048 bytes
    When she uploads a PNG of 2048 bytes to it and finishes the upload
    Then her media lists "diagram.png" as a 2048 byte "image/png"

  Scenario Outline: Only media files are accepted
    When Ana asks to upload "<name>" as "<type>" with 1000 bytes
    Then the upload is refused with "Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV."

    Examples:
      | name       | type            |
      | notes.pdf  | application/pdf |
      | logo.svg   | image/svg+xml   |
      | page.html  | text/html       |

  Scenario: A file can be at most 100 MB
    When Ana asks to upload "talk.mp4" as "video/mp4" with 104857601 bytes
    Then the upload is refused with "A file can be at most 100 MB."

  Scenario: A file that is not what it claims is not kept
    Given Ana asked to upload "photo.png" as "image/png" with 1000 bytes
    When she uploads a PDF of 1000 bytes to it and finishes the upload
    Then the upload is refused with "That file is not a PNG image, so it was not kept."
    And the stored file is gone and her media is empty

  Scenario: Finishing before uploading
    Given Ana asked to upload "clip.webm" as "video/webm" with 5000 bytes
    When she finishes the upload without sending the file
    Then the upload is refused with "The file has not arrived yet. Upload it, then finish again."

  Scenario: Open a file
    Given Ana uploaded "diagram.png"
    When she asks for a link to "diagram.png"
    Then she gets a download link that expires in 1 hour
    And the file address redirects to that kind of link

  Scenario: Delete a file
    Given Ana uploaded "diagram.png"
    When she deletes "diagram.png"
    Then the stored file is gone and her media is empty

  Scenario: Files are private
    Given Ana uploaded "diagram.png"
    And Budi is signed in on another browser
    Then Budi cannot list, open or delete "diagram.png"
    And guests cannot upload

  Scenario: Media is off without R2 settings
    Given the Deyslide API without media storage
    Then the public settings say media is off

  Scenario: Upload links for Cloudflare R2
    Given R2 settings for the account "0123456789abcdef" and the bucket "deyslide-private-assets"
    When an upload link is made for "users/ana/file-1" as "image/png" with 2048 bytes
    Then it is a PUT to "https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/users/ana/file-1"
    And it is signed with SigV4 for the "auto" region and the "s3" service, expiring in 900 seconds
    And the signed headers are "content-length;content-type;host"
