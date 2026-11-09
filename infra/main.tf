locals {
  name     = "pi-durable"
  operator = "user:nkshao17@gmail.com"
  services = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  secrets = toset([
    "model-api-key",
    "telegram-token",
    "github-token",
  ])
}

resource "google_project_service" "required" {
  for_each = local.services

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "vm" {
  account_id   = "${local.name}-vm"
  display_name = "Pi Durable VM"
  description  = "Dedicated VM identity; access to the three Pi Durable secrets only. No service account keys."

  depends_on = [google_project_service.required["iam.googleapis.com"]]
}

# Create only empty secret containers. Values and secret versions are added by the owner.
resource "google_secret_manager_secret" "credentials" {
  for_each = local.secrets

  secret_id           = "${local.name}-${each.value}"
  deletion_protection = true

  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "vm_access" {
  for_each = local.secrets

  secret_id = google_secret_manager_secret.credentials[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_compute_network" "private" {
  name                    = local.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_subnetwork" "private" {
  name                     = "${local.name}-private"
  region                   = var.region
  network                  = google_compute_network.private.id
  ip_cidr_range            = "10.42.0.0/24"
  stack_type               = "IPV4_ONLY"
  private_ip_google_access = true
}

resource "google_compute_address" "nat" {
  name         = "${local.name}-nat"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_router" "nat" {
  name    = "${local.name}-nat"
  region  = var.region
  network = google_compute_network.private.id
}

resource "google_compute_router_nat" "outbound" {
  name                               = "${local.name}-outbound"
  region                             = var.region
  router                             = google_compute_router.nat.name
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  min_ports_per_vm                   = 64

  subnetwork {
    name                    = google_compute_subnetwork.private.id
    source_ip_ranges_to_nat = ["PRIMARY_IP_RANGE"]
  }
}

# This custom VPC has no default ingress rules; all other ingress is implicitly denied.
resource "google_compute_firewall" "iap_ssh" {
  name                    = "${local.name}-iap-ssh"
  network                 = google_compute_network.private.id
  direction               = "INGRESS"
  priority                = 1000
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.vm.email]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

data "google_compute_image" "debian" {
  project = "debian-cloud"
  # systemd >= 257 supplies transient-unit names to the narrow polkit authorization rule.
  family = "debian-13"
}

resource "google_compute_disk" "tasks" {
  name = "${local.name}-tasks"
  zone = var.zone
  type = "pd-balanced"
  size = var.task_disk_size_gib

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_instance" "vm" {
  name                = local.name
  zone                = var.zone
  machine_type        = "e2-standard-4"
  desired_status      = "RUNNING"
  deletion_protection = true
  can_ip_forward      = false

  boot_disk {
    auto_delete = true

    initialize_params {
      image = data.google_compute_image.debian.self_link
      size  = 20
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.tasks.id
    device_name = "pi-durable-tasks"
    mode        = "READ_WRITE"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
    stack_type = "IPV4_ONLY"
    # No access_config: the VM never receives an external IP address.
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata = {
    enable-oslogin           = "TRUE"
    block-project-ssh-keys   = "TRUE"
    disable-legacy-endpoints = "TRUE"
  }

  # Host preparation only: no bot, Coordinator, Pi, credentials or application containers.
  metadata_startup_script = file("${path.module}/scripts/prepare-host.sh")

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    provisioning_model  = "STANDARD"
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  lifecycle {
    # Image-family updates must not replace an existing VM or its boot disk.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }

  depends_on = [google_compute_router_nat.outbound]
}

resource "google_iap_tunnel_instance_iam_member" "operator" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.vm.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = local.operator

  condition {
    title      = "ssh-only"
    expression = "destination.port == 22"
  }

  depends_on = [google_project_service.required["iap.googleapis.com"]]
}

resource "google_compute_instance_iam_member" "operator_oslogin" {
  project       = var.project_id
  zone          = var.zone
  instance_name = google_compute_instance.vm.name
  role          = "roles/compute.osAdminLogin"
  member        = local.operator

  depends_on = [google_project_service.required["oslogin.googleapis.com"]]
}

resource "google_service_account_iam_member" "operator_act_as" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.operator
}
