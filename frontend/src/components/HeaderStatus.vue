<template>
    <div v-if="$root.loggedIn" class="header-status d-flex align-items-center">
        <span class="badge runtime me-2" :class="runtimeRunning ? 'bg-primary' : 'bg-danger'" :title="runtimeTitle">
            <span class="dot"></span>
            {{ runtimeRunning ? $t("runtimeUp") : $t("runtimeDown") }}
        </span>
        <span class="badge bg-secondary me-2" :title="$t('activeStacks')">{{ activeCount }} {{ $t("active") }}</span>
        <span v-if="host" class="metric me-2" :title="$t('hostCpu')">CPU {{ host.cpuPercent }}%</span>
        <span v-if="host" class="metric" :title="$t('hostMem')">{{ memText }}</span>
    </div>
</template>

<script>
import { defineComponent } from "vue";
import { statusNameShort } from "../../../common/util-common";

export default defineComponent({
    computed: {
        systemStatus() {
            return this.$root.systemStatus || {};
        },
        runtimeRunning() {
            return !!this.systemStatus.runtimeRunning;
        },
        host() {
            return this.systemStatus.host || null;
        },
        runtimeTitle() {
            const version = this.systemStatus.runtimeVersion;
            const state = this.runtimeRunning ? this.$t("runtimeUp") : this.$t("runtimeDown");
            return version ? `container ${version} — ${state}` : state;
        },
        activeCount() {
            let count = 0;
            const list = this.$root.completeStackList;
            for (const key in list) {
                if (statusNameShort(list[key].status) === "active") {
                    count += 1;
                }
            }
            return count;
        },
        memText() {
            if (!this.host) {
                return "";
            }
            return `${this.toGiB(this.host.memUsedBytes)} / ${this.toGiB(this.host.memTotalBytes)} GB`;
        },
    },
    methods: {
        toGiB(bytes) {
            return (bytes / 1024 / 1024 / 1024).toFixed(1);
        },
    },
});
</script>

<style scoped lang="scss">
.header-status {
    font-size: 13px;

    .runtime {
        display: inline-flex;
        align-items: center;
    }

    .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #fff;
        margin-right: 5px;
        opacity: 0.9;
    }

    .metric {
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }
}
</style>
