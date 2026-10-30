SHELL := /bin/bash
.PHONY: help install build check test clean harness web
help:
	@echo "Targets: install build check test clean harness web"
install:
	npm ci
build:
	npm run build
check:
	npm run check
test:
	npm test
clean:
	npm run clean
harness:
	npm run harness -- $(MSG)
web:
	npm run web
