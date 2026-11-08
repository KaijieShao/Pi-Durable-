output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "zone" {
  value = var.zone
}

output "vm_name" {
  value = google_compute_instance.vm.name
}

output "vm_private_ip" {
  value = google_compute_instance.vm.network_interface[0].network_ip
}

output "nat_outbound_ip" {
  description = "The only reserved public IP; attached to Cloud NAT, not to the VM."
  value       = google_compute_address.nat.address
}

output "vm_service_account" {
  value = google_service_account.vm.email
}

output "secret_ids" {
  description = "Empty containers only; the owner adds all values directly in Secret Manager."
  value       = { for name, secret in google_secret_manager_secret.credentials : name => secret.id }
}

output "task_disk_size_gib" {
  value = var.task_disk_size_gib
}

output "iap_ssh_command" {
  value = "gcloud compute ssh ${google_compute_instance.vm.name} --project=${var.project_id} --zone=${var.zone} --tunnel-through-iap --account=nkshao17@gmail.com"
}
