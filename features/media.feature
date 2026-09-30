Feature: Project media libraries
  As a signed in person
  I want to upload images, video and audio into a project
  So that its decks can use them, my team can too, and nobody else can open them

  Background:
    Given the Deyslide API with media storage
    And Ana is signed in with the project "Algorithms 101"

  Scenario: Upload an image
    When Ana asks to upload "diagram.png" as "image/png" with 2048 bytes
    Then she gets an upload link that expires in 15 minutes and is signed for "image/png" and 2048 bytes
    And the file is stored under the project
    When she uploads a PNG of 2048 bytes to it and finishes the upload
    Then the project's media lists "diagram.png" as a 2048 byte "image/png"
    And 2048 bytes of her 1 GB are used

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
    And the stored file is gone and the project's media is empty

  Scenario: Finishing before uploading
    Given Ana asked to upload "clip.webm" as "video/webm" with 5000 bytes
    When she finishes the upload without sending the file
    Then the upload is refused with "The file has not arrived yet. Upload it, then finish again."

  Scenario: Open a file
    Given Ana uploaded "diagram.png"
    When she asks for a link to "diagram.png"
    Then she gets a download link that expires in 15 minutes
    And the file address redirects to that kind of link

  Scenario: Delete a file
    Given Ana uploaded "diagram.png"
    When she deletes "diagram.png"
    Then the stored file is gone and the project's media is empty
    And none of her storage is used

  Scenario: Each account has 1 GB for all its projects
    Given Ana already stores 1000 MB of files in another project
    When Ana asks to upload "talk.mp4" as "video/mp4" with 52428800 bytes
    Then the upload is refused with "This file does not fit in your 1 GB of storage, which has 24 MB left. Delete some files first."

  Scenario: The limit comes from the server settings
    Given the Deyslide API with media storage and a limit of 1 MB for each account
    And Ana is signed in with the project "Algorithms 101"
    When Ana asks to upload "photo.png" as "image/png" with 2097152 bytes
    Then the upload is refused with "This file does not fit in your 1 MB of storage, which has 1 MB left. Delete some files first."

  Scenario: Uploads started together cannot pass the limit
    Given the Deyslide API with media storage and a limit of 1 MB for each account
    And Ana is signed in with the project "Algorithms 101"
    When Ana asks to upload two files of 600000 bytes at the same time
    Then one gets an upload link and the other is refused

  Scenario: The team shares the project's files
    Given Ana uploaded "diagram.png"
    And Ana shares the project with Budi as an editor and with Citra as a viewer
    Then Budi and Citra see "diagram.png" in the project's media and can open it
    When Budi uploads "chart.png" of 4096 bytes
    Then the project's media lists "chart.png" and "diagram.png"
    And the 4096 bytes count toward Ana's storage, not Budi's
    But Citra cannot add files
    And only Ana can delete files

  Scenario: An editor's upload that does not fit in the owner's storage
    Given Ana already stores 1000 MB of files in another project
    And Ana shares the project with Budi as an editor
    When Budi asks to upload "talk.mp4" as "video/mp4" with 52428800 bytes
    Then the upload is refused with "This file does not fit in the project owner's 1 GB of storage. Ask them to delete some files first."

  Scenario: Someone given one deck opens only the files that deck shows
    Given Ana uploaded "diagram.png" and "secret.png"
    And her deck "Sorting" shows "diagram.png"
    And Ana shares only the deck "Sorting" with Budi
    Then Budi can open "diagram.png"
    But Budi cannot open "secret.png" or list the project's media

  Scenario: Files are private
    Given Ana uploaded "diagram.png"
    And Budi is signed in on another browser
    Then Budi cannot list, add, open, finish or delete files in the project
    And guests cannot upload

  Scenario: Deleting a project deletes its files
    Given Ana uploaded "diagram.png"
    When she deletes the project
    Then the stored file is gone
    And none of her storage is used

  Scenario: Media is off without R2 settings
    Given the Deyslide API without media storage
    Then the public settings say media is off

  Scenario: Upload links for Cloudflare R2
    Given R2 settings for the account "0123456789abcdef" and the bucket "deyslide-private-assets"
    When an upload link is made for "projects/p1/file-1" as "image/png" with 2048 bytes
    Then it is a PUT to "https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/projects/p1/file-1"
    And it is signed with SigV4 for the "auto" region and the "s3" service, expiring in 900 seconds
    And the signed headers are "content-length;content-type;host"
