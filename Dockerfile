FROM nginx:latest

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Create nginx config for Cloud Run
RUN echo 'server { \
    listen 8080; \
    server_name localhost; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Copy application
COPY index.html /usr/share/nginx/html/index.html

# Expose Cloud Run port
EXPOSE 8080

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
