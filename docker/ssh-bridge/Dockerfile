FROM alpine:3.20
RUN apk add --no-cache openssh docker-cli docker-cli-compose bash curl sudo git git-lfs jq
RUN adduser -D -s /bin/bash deploy && \
    passwd -d deploy && \
    mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && \
    chown deploy:deploy /home/deploy/.ssh && \
    echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy && \
    chmod 440 /etc/sudoers.d/deploy
RUN ssh-keygen -A && mkdir -p /run/sshd
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
