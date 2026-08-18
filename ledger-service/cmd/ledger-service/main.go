// Command ledger-service runs the core ledger HTTP API.
package main

import (
	"log"
	"net/http"
	"os"

	"ledger-rail/ledger-service/internal/httpapi"
	"ledger-rail/ledger-service/internal/ledger"
	"ledger-rail/ledger-service/internal/postgres"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://ledger:ledger@localhost:5432/ledger?sslmode=disable"
	}

	store, err := postgres.Open(dsn)
	if err != nil {
		log.Fatalf("open postgres: %v", err)
	}
	defer store.Close()

	svc := ledger.NewService(store)
	server := httpapi.NewServer(svc)

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	log.Printf("ledger-service listening on %s", addr)
	if err := http.ListenAndServe(addr, server); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
