package ports

import "github.com/smithersai/smithers/packages/backend/internal/services"

// CanaryRunSource supplies recorded deployment evidence to GET /api/status.
type CanaryRunSource = services.CanaryRunSource
type CanaryRun = services.CanaryRun
