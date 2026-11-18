<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveGeneral">
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Display Timezone") }}
                </label>
                <select id="timezone" v-model="$root.userTimezone" class="form-select">
                    <option value="auto">
                        {{ $t("Auto") }}: {{ guessTimezone }}
                    </option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Server Timezone") }}
                </label>
                <select id="timezone" v-model="settings.serverTimezone" class="form-select">
                    <option value="UTC">UTC</option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <div class="mb-4">
                <label class="form-label" for="primaryBaseURL">
                    {{ $t("primaryHostname") }}
                </label>

                <div class="input-group mb-3">
                    <input
                        v-model="settings.primaryHostname"
                        class="form-control"
                        :placeholder="$t(`CurrentHostname`)"
                    />
                    <button class="btn btn-outline-primary" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <div class="form-text"></div>
            </div>

            <div class="mb-4">
                <label class="form-label" for="serviceDnsDomain">
                    {{ $t("serviceDnsDomain") }}
                </label>

                <input
                    id="serviceDnsDomain"
                    v-model="settings.serviceDnsDomain"
                    class="form-control"
                    placeholder="boxge.test"
                    autocapitalize="off"
                    spellcheck="false"
                />

                <div class="form-text">
                    {{ $t("serviceDnsDomainHelp") }}
                </div>

                <div v-if="dnsNeedsSetup" class="alert alert-warning mt-2 mb-0" role="alert">
                    {{ $t("serviceDnsDomainSetup") }}
                    <code class="d-block mt-1">sudo container system dns create {{ activeDnsDomain }}</code>
                </div>
                <div v-else-if="activeDnsDomain" class="form-text text-success">
                    {{ $t("serviceDnsDomainReady", [ activeDnsDomain ]) }}
                </div>
            </div>

            <div>
                <button class="btn btn-primary" type="submit">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>

import dayjs from "dayjs";
import { timezoneList } from "../../util-frontend";

export default {
    components: {

    },

    data() {
        return {
            timezoneList: timezoneList(),
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        guessTimezone() {
            return dayjs.tz.guess();
        },
        activeDnsDomain() {
            return (this.$root.systemStatus || {}).serviceDnsDomain || "";
        },
        dnsNeedsSetup() {
            const status = this.$root.systemStatus || {};
            return !!status.serviceDnsDomain && !!status.runtimeRunning && !status.serviceDnsRegistered;
        },
    },

    methods: {
        saveGeneral() {
            localStorage.timezone = this.$root.userTimezone;
            this.saveSettings();
        },
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },
    },
};
</script>

