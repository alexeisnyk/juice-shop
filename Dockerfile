# 1. Start with your original version
FROM node:12.18.4-buster

# 2. EMERGENCY REPOSITORY FIX
# We must point to 'archive.debian.org' because 'deb.debian.org' no longer hosts Buster
RUN sed -i s/deb.debian.org/archive.debian.org/g /etc/apt/sources.list && \
    sed -i 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    sed -i '/buster-updates/d' /etc/apt/sources.list

# 3. Install system dependencies
# We use --allow-check-valid-until because the archive timestamps are "expired"
RUN apt-get -y -o Acquire::Check-Valid-Until=false update && \
    apt-get -y install --no-install-recommends \
    ca-certificates \
    apt-transport-https \
    python \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 4. Setup User
RUN addgroup --system --gid 1001 juicer && \
    adduser juicer --system --uid 1001 --ingroup juicer

WORKDIR /juice-shop
COPY --chown=juicer:juicer . .

# 5. Install NPM dependencies
# In Node 12, we don't need --legacy-peer-deps, but we DO need build tools
RUN npm install --production --unsafe-perm

# 6. Cleanup and Permissions
RUN npm dedupe && \
    rm -rf frontend/node_modules && \
    mkdir -p logs && \
    chown -R juicer logs && \
    chgrp -R 0 ftp/ frontend/dist/ logs/ data/ i18n/ && \
    chmod -R g=u ftp/ frontend/dist/ logs/ data/ i18n/

USER 1001
EXPOSE 3000
CMD ["npm", "start"]
