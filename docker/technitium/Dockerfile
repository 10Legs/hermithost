FROM technitium/dns-server:latest

# Add iproute2 for ss, ip, and other network diagnostics
RUN apt-get update -qq && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
