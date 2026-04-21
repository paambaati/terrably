terraform {
  required_providers {
    dummycloud = {
      source = "example/dummycloud"
    }
  }
}

provider "dummycloud" {
  api_url = "http://127.0.0.1:19876"
}

resource "dummycloud_server" "web" {
  name = "web-01"
  size = "small"
}

resource "dummycloud_server" "db" {
  name = "db-01"
  size = "large"
}

output "web_id" {
  value = dummycloud_server.web.id
}

output "web_status" {
  value = dummycloud_server.web.status
}
