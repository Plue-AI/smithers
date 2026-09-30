package repohost

// Upload-pack admission codes distinguish bounded refusals from proxy failures.
const (
	UploadPackQueueFullCode           = "upload_pack_queue_full"
	UploadPackQueueTimeoutCode        = "upload_pack_queue_timeout"
	UploadPackNegotiationTooLargeCode = "upload_pack_negotiation_too_large"
)
