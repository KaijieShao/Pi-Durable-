variable "project_id" {
  description = "Existing, billing-enabled GCP project. Terraform does not create or change billing accounts."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use an existing GCP project ID."
  }
}

variable "region" {
  description = "Single region for the subnet, NAT and VM. v64 does not prescribe a region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Single VM and persistent-disk zone; no cross-zone failover."
  type        = string
  default     = "us-central1-a"

  validation {
    condition     = startswith(var.zone, "${var.region}-")
    error_message = "The zone must be in the configured region."
  }
}

variable "task_disk_size_gib" {
  description = "Provisional task-disk budget; v64 requires a separate disk and leaves sizing to stress testing."
  type        = number
  default     = 50

  validation {
    condition     = var.task_disk_size_gib >= 10 && floor(var.task_disk_size_gib) == var.task_disk_size_gib
    error_message = "The task disk must be a whole number of GiB, at least 10."
  }
}
