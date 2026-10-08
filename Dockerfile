FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node server ./server
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
