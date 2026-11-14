FROM alpine:3.24
# openssh-server >= 10.3_p1-r2 fixes CVE-2026-123158 ("sshole"); the build fails
# rather than ship an older sshd.
RUN apk upgrade --no-cache && \
    apk add --no-cache openssh 'openssh-server>=10.3_p1-r2' docker-cli docker-cli-compose bash curl sudo git git-lfs jq
# deploy gets a "*" (no valid password) shadow entry rather than an empty one, so
# su and anything else reading shadow can't use it. Not `passwd -l`: sshd without
# PAM treats a "!" entry as locked and refuses key logins too.
RUN adduser -D -s /bin/bash deploy && \
    sed -i 's/^deploy:[^:]*:/deploy:*:/' /etc/shadow && \
    grep -q '^deploy:\*:' /etc/shadow && \
    mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && \
    chown deploy:deploy /home/deploy/.ssh && \
    echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy && \
    chmod 440 /etc/sudoers.d/deploy
RUN ssh-keygen -A && mkdir -p /run/sshd
COPY 00-hermithost-keys-only.conf /etc/ssh/sshd_config.d/00-hermithost-keys-only.conf
# Fail the build if the drop-in isn't picked up (sshd uses the first value it sees).
RUN sshd -t && \
    sshd -T | grep -qx 'passwordauthentication no' && \
    sshd -T | grep -qx 'kbdinteractiveauthentication no' && \
    sshd -T | grep -qx 'permitemptypasswords no'
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
