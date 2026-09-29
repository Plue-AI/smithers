# Page limits

`GET /api/share/listings` and `GET /api/share/my/listings` accept `page` and `perPage`. The page size defaults to 25 and is capped at 100. Pages whose database offset exceeds a signed 64-bit integer return HTTP 400.

`GET /api/orgs/{org}/changesets` accepts `page` and `per_page`. The page size defaults to 30 when it is outside 1–100. Pages whose database offset exceeds a signed 32-bit integer return HTTP 400.
