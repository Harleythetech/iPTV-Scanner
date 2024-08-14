document.addEventListener('DOMContentLoaded', () => {
    const playlistUrlInput = document.getElementById('playlisturl');
    const fileInput = document.getElementById('file');
    const checkButton = document.getElementById('check');
    const clearButton = document.getElementById('clear');
    const tbody = document.querySelector('tbody');

    checkButton.addEventListener('click', handleCheck);
    clearButton.addEventListener('click', clearResults);

    async function handleCheck() {
        //buttons
        checkButton.disabled = true;
        clearButton.disabled = true;
        checkButton.textContent = "Scanning...";

        let m3uContent;

        if (playlistUrlInput.value) {
            try {
                const response = await fetch(playlistUrlInput.value);
                m3uContent = await response.text();
            } catch (error) {
                alert('Error fetching M3U content. Please check the URL and try again.');
                return;
            }
        } else if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            m3uContent = await file.text();
        } else {
            alert('Please enter a URL or select a file.');
            return;
        }

        const channels = parseM3U(m3uContent);
        await checkChannels(channels);
        enableButtons();
    }

    function enableButtons(){
        checkButton.disabled = false;
        clearButton.disabled = false;
        checkButton.textContent = "Check";
    }

    function parseM3U(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentChannel = {};

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                const nameMatch = line.match(/,(.+)$/);
                if (nameMatch) {
                    currentChannel.name = nameMatch[1].trim();
                }
            } else if (line.trim() !== '' && !line.startsWith('#')) {
                currentChannel.url = line.trim();
                channels.push(currentChannel);
                currentChannel = {};
            }
        }

        return channels;
    }

    async function checkChannels(channels) {
        clearResults();
        const totalChannels = channels.length;
        for (let i = 0; i < totalChannels; i++) {
            const channel = channels[i];
            const row = tbody.insertRow();
            row.innerHTML = `
                <td>${i + 1}</td>
                <td>${channel.name}</td>
                <td>Checking...</td>
                <td>-</td>
            `;
    
            //add checking progress
            checkButton.textContent = `Scanning... ${Math.round((i+1) / totalChannels * 100)}%`;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
                const response = await fetch(channel.url, {
                    method: 'GET',
                    mode: 'cors', // Try with 'cors' first
                    signal: controller.signal
                });
    
                clearTimeout(timeoutId);
    
                if (response.ok) {
                    row.cells[2].textContent = 'Active';
                    row.cells[3].textContent = response.status;
                    row.cells[2].classList.add('text-success');
                } else {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    row.cells[2].textContent = 'Timeout';
                    row.cells[3].textContent = 'No response';
                } else {
                    row.cells[2].textContent = 'Inactive';
                    row.cells[3].textContent = error.message || 'Error';
                }
                row.cells[2].classList.add('text-danger');
            }
        }
    }

    function clearResults() {
        tbody.innerHTML = '';
        playlistUrlInput.value = '';
        fileInput.value = '';
        enableButtons();
    }
});