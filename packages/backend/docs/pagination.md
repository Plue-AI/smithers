# Page limits

`GET /api/share/listings` and `GET /api/share/my/listings` accept `page` and `perPage`. The page size defaults to 25 and is capped at 100. Pages whose database offset exceeds a signed 64-bit integer return HTTP 400.

