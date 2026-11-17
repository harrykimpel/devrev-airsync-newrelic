#!/bin/bash
# Shared by deploy.sh and cleanup.sh; uses their error()/success() helpers.
authenticate_devrev() {
    local environment="$1"
    local organization="$2"
    local user_email="$3"
    local auth_help
    local environment_args=()

    # Current production CLI releases have no environment flag. Older/internal
    # versions may expose --env or -e; use only flags advertised by this CLI.
    if ! auth_help=$(devrev profiles authenticate --help 2>&1); then
        error "Unable to read DevRev CLI authentication options"
        echo "$auth_help"
        return 1
    fi
    if grep -qE '(^|[[:space:],])--env([=[:space:]]|$)' <<<"$auth_help"; then
        environment_args=(--env "$environment")
    elif grep -qE '(^|[[:space:],])-e([,[:space:]]|$)' <<<"$auth_help"; then
        environment_args=(-e "$environment")
    elif [ "$environment" != "prod" ]; then
        error "This DevRev CLI does not support environment selection (ENV=$environment). Use ENV=prod for production, or a CLI that supports your target environment."
        return 1
    fi

    # Codespaces/CI can provide a PAT without a browser callback. Import via
    # stdin: never put the credential in CLI arguments or deployment logs.
    if [ -n "${DEVREV_TOKEN:-}" ]; then
        if ! printf '%s\n' "$DEVREV_TOKEN" | devrev profiles set-token "${environment_args[@]}" --org "$organization" --usr "$user_email" >/dev/null 2>&1; then
            error "Could not save DEVREV_TOKEN to the selected CLI profile. Check that it is a DevRev PAT for $organization."
            return 1
        fi
        if ! devrev snap_in_package list "${environment_args[@]}" --org "$organization" --usr "$user_email" --first-n 1 >/dev/null 2>&1; then
            error "DEVREV_TOKEN could not access snap-in packages. Check the PAT, target organization and permissions. Browser login was not attempted."
            return 1
        fi
        success "Authenticated with DEVREV_TOKEN for $organization ($environment)"
        return 0
    fi

    # Explicit org/user selectors also select the CLI context for subsequent
    # deployment/cleanup commands (the CLI saves the last-used org and user).
    local expiry_raw expiry_for_date expiry_without_fraction expiry_epoch=""
    expiry_raw=$(devrev profiles get-token expiry "${environment_args[@]}" --org "$organization" --usr "$user_email" 2>/dev/null)
    if [ -n "$expiry_raw" ]; then
        expiry_for_date="$expiry_raw"
        # Go timestamps include both an offset and a zone name. GNU date
        # rejects that combination; retain the offset and remove only the name.
        if [[ "$expiry_for_date" =~ ^(.+[[:space:]][+-][0-9]{4})[[:space:]][[:alnum:]+-]+$ ]]; then
            expiry_for_date="${BASH_REMATCH[1]}"
        fi
        expiry_without_fraction=$(sed -E 's/([0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]+/\1/' <<<"$expiry_for_date")
        # GNU date (Linux), then BSD date (macOS).
        expiry_epoch=$(date -d "$expiry_for_date" +%s 2>/dev/null \
            || date -j -f "%Y-%m-%d %H:%M:%S %z" "$expiry_without_fraction" +%s 2>/dev/null \
            || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$expiry_without_fraction" +%s 2>/dev/null)
    fi

    if [ -n "$expiry_epoch" ] && [ "$expiry_epoch" -gt "$(date +%s)" ]; then
        success "Already authenticated as $user_email into $organization ($environment) — token valid until $expiry_raw"
    elif [[ "$expiry_raw" == 0001-01-01* ]] || { [ -n "$expiry_raw" ] && [ -z "$expiry_epoch" ]; }; then
        # Manually imported PATs can have Go's zero timestamp rather than an
        # expiry. Unknown metadata is not proof of an expired credential.
        if ! devrev snap_in_package list "${environment_args[@]}" --org "$organization" --usr "$user_email" --first-n 1 >/dev/null 2>&1; then
            error "Could not validate the saved token for $organization. Check the PAT, CLI profile, network and snap-in permissions. Browser login was not attempted."
            return 1
        fi
        success "Authenticated with the saved token for $organization ($environment); expiry metadata is unavailable"
    else
        if [ "${CODESPACES:-}" = "true" ]; then
            error "No usable saved token was found. In Codespaces, set DEVREV_TOKEN to a DevRev PAT or use 'devrev profiles set-token --org $organization --usr $user_email'. Browser login was not attempted."
            return 1
        fi
        echo "Authenticating as $user_email into $organization ($environment)..."
        if ! devrev profiles authenticate "${environment_args[@]}" --usr "$user_email" --org "$organization" --expiry 5; then
            error "DevRev authentication failed"
            return 1
        fi
        success "Authenticated"
    fi
}
