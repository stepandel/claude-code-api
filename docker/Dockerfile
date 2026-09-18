FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git util-linux procps \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:$PATH
# Official, unmodified binary. Pin an audited version through --build-arg for deployments.
ARG CLAUDE_VERSION=stable
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh \
    && bash /tmp/install-claude.sh "$CLAUDE_VERSION" && rm /tmp/install-claude.sh
WORKDIR /workspace
CMD ["sleep", "infinity"]
