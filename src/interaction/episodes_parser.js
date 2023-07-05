function parse(data){
    let result = {
        hash_string: '',
        season: data.movie.number_of_seasons ? 1 : 0,
        episode: 0,
        serial: !!data.movie.number_of_seasons
    }

    const regexps = [
        /s(?<season>[0-9]+)\.?ep?(?<episode>[0-9]+)/i,
        /s(?<season>[0-9]{2})(?<episode>[0-9]+)/i,
        /s(?<season>[0-9]+)/i,
        /[ |\[(](?<season>[0-9]{1,2})x(?<episode>[0-9]+)/i,
        /[ |\[(](?<season>[0-9]{1,3}) of (?<episode>[0-9]+)/i,
        /ep(?<episode>[0-9]+)/i,
        /ep\.(?<episode>[0-9]+)/i,
        / - (?<episode>[0-9]+)/i,
        /\[(?<episode>[0-9]+)]/i,

    ]

    regexps.forEach(regexp=>{
        let match = data.path.split('/').pop().match(regexp)

        if (match && match.groups && match.groups.season)
            result.season  = parseInt(match.groups.season)

        if (match && match.groups && match.groups.episode) {
            if (data.movie.number_of_seasons && result.season === 0)
                result.season = 1;
            result.episode = parseInt(match.groups.episode)
        }
    })

    if(result.episode == 0){
        let ep = parseInt(data.filename.slice(0,3))

        if(!isNaN(ep)) result.episode = ep
    }

    if (!data.is_file) {
        if (data.movie.number_of_seasons) {
            result.hash_string = [result.season, result.episode, data.movie.original_title].join('')
        } else if (data.movie.original_title && !result.serial) {
            result.hash_string = data.movie.original_title
        } else {
            result.hash_string = data.path
        }
    } else {
        result.hash_string = data.path
    }

    return result
}


export default {
    parse
}